import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ServerConfig } from '../config';

const equalToken = (provided: string, expected: string) => {
  const first = Buffer.from(provided);
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
};

const defaultOrigins = (config: ServerConfig) => new Set([
  `http://127.0.0.1:${config.port}`,
  `http://localhost:${config.port}`,
  config.host !== '0.0.0.0' ? `http://${config.host}:${config.port}` : '',
  ...config.allowedOrigins
].filter(Boolean));

const setCors = (response: Response, origin: string) => {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  response.vary('Origin');
};

export const sendMcpHttpError = (response: Response, status: number, code: number, message: string) => {
  if (response.headersSent) return;
  response.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
};

export const httpGuard = (config: ServerConfig) => {
  const origins = defaultOrigins(config);
  return (request: Request, response: Response, next: NextFunction) => {
    const origin = request.header('origin');
    if (origin && !origins.has(origin)) {
      sendMcpHttpError(response, 403, -32000, 'Origin is not allowed.');
      return;
    }
    if (origin) setCors(response, origin);
    const authorization = request.header('authorization') || '';
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    if (!match?.[1] || !equalToken(match[1], config.authToken)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      sendMcpHttpError(response, 401, -32000, 'Missing or invalid bearer token.');
      return;
    }
    next();
  };
};

export const optionsGuard = (config: ServerConfig) => {
  const origins = defaultOrigins(config);
  return (request: Request, response: Response) => {
    const origin = request.header('origin');
    if (!origin || !origins.has(origin)) {
      response.status(403).end();
      return;
    }
    setCors(response, origin);
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,mcp-protocol-version,mcp-session-id,last-event-id');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    response.setHeader('Access-Control-Max-Age', '600');
    response.status(204).end();
  };
};
