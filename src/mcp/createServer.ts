import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RuntimeState } from '../types/runtime';
import { registerPrompts } from './registerPrompts';
import { registerResources } from './registerResources';
import { registerInputTools } from './tools/inputTools';
import { registerObservationTools } from './tools/observationTools';
import { registerServiceTools } from './tools/serviceTools';
import { registerSystemTools } from './tools/systemTools';

const instructions = `Acquire a session-bound input lease with computer_control before any desktop mutation. Ground targets with computer_observe and computer_locate, then prefer snapshot-scoped element IDs and verified prepare/commit pointer actions. Use fast or standard local perception for routine UI and reserve deep or optional vision ranking for ambiguous canvas, 3D, and game scenes. Batch multi-stroke drawing, continuous 3D or game control, and other ordered input into one computer_input_timeline call. Refine a vision:grid element through computer_observe region inputs before acting unless the caller explicitly accepts its coarse center. Never guess a coordinate when the server reports ambiguity or stale state.`;

export const createMcpServer = (state: RuntimeState, clientId: string) => {
  const server = new McpServer(
    { name: 'computer-use-win-opencv-mcp', version: '0.1.0' },
    { capabilities: { logging: {} }, instructions }
  );
  registerResources(server, state);
  registerPrompts(server);
  registerSystemTools(server, state, clientId);
  registerObservationTools(server, state);
  registerInputTools(server, state, clientId);
  registerServiceTools(server, state, clientId);
  return server;
};
