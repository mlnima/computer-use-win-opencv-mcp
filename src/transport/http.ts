import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeState } from '../types/runtime';
import { createMcpServer } from '../mcp/createServer';
import { releaseClientControl } from '../runtime/control';
import { httpGuard, optionsGuard, sendMcpHttpError } from './guards';

const sessionSweepMs = 60_000;

export type HttpSessionCloseReason = 'delete' | 'idle' | 'shutdown' | 'transport' | 'initialization';

export type HttpLifecycleOptions = {
  onSessionClosed?: (sessionId: string, reason: HttpSessionCloseReason) => Promise<void> | void;
};

type Session = {
  id?: string;
  clientId: string;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
  lastUsedAt: number;
  activeRequests: number;
  closing: boolean;
  closeReason?: HttpSessionCloseReason;
  closePromise?: Promise<void>;
};

export type HttpRuntime = {
  server: Server;
  sessions: Map<string, Session>;
  close: () => Promise<void>;
};

const closeSession = (
  state: RuntimeState,
  sessions: Map<string, Session>,
  session: Session,
  reason: HttpSessionCloseReason,
  options: HttpLifecycleOptions
) => {
  if (session.closing) return session.closePromise || Promise.resolve();
  session.closing = true;
  session.closeReason = reason;
  if (session.id) sessions.delete(session.id);
  const operation = (async () => {
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
    await releaseClientControl(state, session.clientId).catch(() => undefined);
    if (session.id) await Promise.resolve(options.onSessionClosed?.(session.id, reason)).catch(() => undefined);
  })();
  session.closePromise = operation;
  return operation;
};

const findSession = (sessions: Map<string, Session>, request: Request, response: Response) => {
  const id = request.header('mcp-session-id');
  const session = id ? sessions.get(id) : undefined;
  if (!id) sendMcpHttpError(response, 400, -32000, 'Mcp-Session-Id is required.');
  else if (!session) sendMcpHttpError(response, 404, -32001, 'MCP session was not found.');
  return session;
};

const handleSessionRequest = async (
  state: RuntimeState,
  sessions: Map<string, Session>,
  session: Session,
  request: Request,
  response: Response,
  options: HttpLifecycleOptions,
  body?: unknown,
  propagateError = false
) => {
  if (session.closing) {
    sendMcpHttpError(response, 404, -32001, 'MCP session was not found.');
    return;
  }
  session.lastUsedAt = Date.now();
  session.activeRequests += 1;
  if (request.method === 'DELETE') session.closeReason = 'delete';
  try {
    await session.transport.handleRequest(request, response, body);
  } catch (error) {
    if (propagateError) throw error;
    sendMcpHttpError(response, 500, -32603, 'Internal server error.');
  } finally {
    session.activeRequests -= 1;
    session.lastUsedAt = Date.now();
    if (request.method === 'DELETE') await closeSession(state, sessions, session, 'delete', options);
  }
};

export const startHttpTransport = async (
  state: RuntimeState,
  options: HttpLifecycleOptions = {}
): Promise<HttpRuntime> => {
  const app = express();
  const sessions = new Map<string, Session>();
  const sockets = new Set<Socket>();
  let pendingInitializations = 0;
  let closing = false;
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    if (!closing) next();
    else sendMcpHttpError(response, 503, -32000, 'MCP server is shutting down.');
  });
  app.options('/mcp', optionsGuard(state.config));
  app.use('/mcp', httpGuard(state.config));
  app.use('/mcp', express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
  app.post('/mcp', async (request, response) => {
    try {
      const sessionId = request.header('mcp-session-id');
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        await handleSessionRequest(state, sessions, existing, request, response, options, request.body);
        return;
      }
      if (sessionId) {
        sendMcpHttpError(response, 404, -32001, 'MCP session was not found.');
        return;
      }
      if (!isInitializeRequest(request.body)) {
        sendMcpHttpError(response, 400, -32000, 'MCP initialization is required.');
        return;
      }
      if (closing) {
        sendMcpHttpError(response, 503, -32000, 'MCP server is shutting down.');
        return;
      }
      if (sessions.size + pendingInitializations >= state.config.maxHttpSessions) {
        sendMcpHttpError(response, 503, -32000, 'MCP session limit reached.');
        return;
      }
      pendingInitializations += 1;
      let reserved = true;
      const releaseReservation = () => {
        if (!reserved) return;
        reserved = false;
        pendingInitializations -= 1;
      };
      let mcpServer: ReturnType<typeof createMcpServer> | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      let session: Session | undefined;
      try {
        const clientId = randomUUID();
        mcpServer = createMcpServer(state, clientId);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: async (id) => {
            if (!session) return;
            session.id = id;
            releaseReservation();
            if (closing) await closeSession(state, sessions, session, 'shutdown', options);
            else sessions.set(id, session);
          }
        });
        session = {
          clientId,
          transport,
          server: mcpServer,
          lastUsedAt: Date.now(),
          activeRequests: 0,
          closing: false
        };
        transport.onclose = () => { void closeSession(state, sessions, session!, session?.closeReason || 'transport', options); };
        await mcpServer.connect(transport);
        await handleSessionRequest(state, sessions, session, request, response, options, request.body, true);
        if (!session.id) {
          await closeSession(state, sessions, session, 'initialization', options);
          sendMcpHttpError(response, 500, -32603, 'MCP initialization failed.');
        }
      } catch {
        if (session) await closeSession(state, sessions, session, 'initialization', options);
        else {
          await transport?.close().catch(() => undefined);
          await mcpServer?.close().catch(() => undefined);
        }
        sendMcpHttpError(response, 500, -32603, 'MCP initialization failed.');
      } finally {
        releaseReservation();
      }
    } catch {
      sendMcpHttpError(response, 500, -32603, 'Internal server error.');
    }
  });
  const existingRoute = async (request: Request, response: Response) => {
    try {
      const session = findSession(sessions, request, response);
      if (session) await handleSessionRequest(state, sessions, session, request, response, options);
    } catch {
      sendMcpHttpError(response, 500, -32603, 'Internal server error.');
    }
  };
  app.get('/mcp', existingRoute);
  app.delete('/mcp', existingRoute);
  app.all('/mcp', (_request, response) => {
    response.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    sendMcpHttpError(response, 405, -32000, 'Method not allowed.');
  });
  app.get('/health', httpGuard(state.config), (_request, response) => response.json({
    ok: true,
    sessions: sessions.size,
    pendingInitializations
  }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = Number((error as { status?: unknown })?.status) || 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    sendMcpHttpError(response, safeStatus, safeStatus === 413 ? -32000 : -32700, safeStatus === 413 ? 'Request body is too large.' : 'Invalid HTTP request.');
  });
  const server = createServer(app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen(state.config.port, state.config.host, () => {
      server.off('error', failed);
      resolve();
    });
  });
  const sweep = setInterval(() => {
    const cutoff = Date.now() - state.config.httpSessionIdleMs;
    for (const session of sessions.values()) {
      if (!session.activeRequests && session.lastUsedAt <= cutoff) void closeSession(state, sessions, session, 'idle', options);
    }
  }, Math.max(1000, Math.min(sessionSweepMs, state.config.httpSessionIdleMs)));
  sweep.unref();
  let closePromise: Promise<void> | undefined;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(sweep);
    let forceTimer: NodeJS.Timeout | undefined;
    const stopped = new Promise<void>((resolve, reject) => server.close((error) => {
      if (forceTimer) clearTimeout(forceTimer);
      error ? reject(error) : resolve();
    }));
    forceTimer = setTimeout(() => {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    }, 2_000);
    forceTimer.unref();
    const closedSessions = Promise.all([...sessions.values()].map((session) => closeSession(state, sessions, session, 'shutdown', options)));
    closePromise = Promise.all([closedSessions, stopped]).then(() => undefined);
    return closePromise;
  };
  return { server, sessions, close };
};
