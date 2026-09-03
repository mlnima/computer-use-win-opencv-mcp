import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RuntimeState } from '../types/runtime';
import { createMcpServer } from '../mcp/createServer';
import { releaseClientControl } from '../runtime/control';

export const startStdioTransport = async (state: RuntimeState) => {
  const clientId = `stdio:${randomUUID()}`;
  const server = createMcpServer(state, clientId);
  const transport = new StdioServerTransport();
  transport.onclose = () => { void releaseClientControl(state, clientId).catch(() => undefined); };
  await server.connect(transport);
  return server;
};
