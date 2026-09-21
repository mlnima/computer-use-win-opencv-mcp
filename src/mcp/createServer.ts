import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RuntimeState } from '../types/runtime';
import { registerPrompts } from './registerPrompts';
import { registerResources } from './registerResources';
import { registerInputTools } from './tools/inputTools';
import { registerObservationTools } from './tools/observationTools';
import { registerServiceTools } from './tools/serviceTools';
import { registerSystemTools } from './tools/systemTools';
import { registerOperationReceipts } from './registerOperationReceipts';
import { registerObservationContext } from './observationContext';

const instructions = `This server operates the remote Windows OS, including native applications, files, dialogs, and browsers. Acquire a session-bound input lease with computer_control before any desktop mutation. Ground UI targets with computer_observe and computer_locate, then use snapshot-scoped element IDs and verified prepare/commit pointer actions. Start with accessibility mode for native controls, use fast or standard when visual detection is needed, and screenshot mode for visual outcome checks. Deep mode adds inline labeled evidence. Inspect retrieves full evidence for a compact element. Select the actionable control rather than an overlapping label or container. Inspect the hover image when uncertain and verify the post-action image before continuing. An executed input is not proof of task success; do not repeat it blindly if post-observation failed. Never bypass a rejected click target using raw pointer input. Raw presses and held-input timelines require explicitly identified canvas surfaces. Wheel scrolling also permits normal UI controls inside a fresh observed element or region; use 120 units per notch. Batch bounded multi-stroke or held-input sequences within the identified surface. Refine coarse vision:grid targets with a region observation. Never guess when grounding is ambiguous or stale.`;

export const createMcpServer = (state: RuntimeState, clientId: string) => {
  const server = new McpServer(
    { name: 'computer-use-win-opencv-mcp', version: '0.1.0' },
    { capabilities: { logging: {}, experimental: {
      'io.eskai/computerControl': { tool: 'computer_control', renewalTtlMs: 30000 },
      'io.eskai/operationReceipts': {
        statusTool: 'computer_operation_status', acknowledgeTool: 'computer_operation_acknowledge',
        excludedTools: ['computer_control', 'computer_operation_status', 'computer_operation_acknowledge'],
      },
    } }, instructions }
  );
  registerResources(server, state);
  registerPrompts(server);
  const resolveObservationId = registerObservationContext(server, state);
  registerOperationReceipts(server, state);
  registerSystemTools(server, state, clientId);
  registerObservationTools(server, state, resolveObservationId);
  registerInputTools(server, state, clientId);
  registerServiceTools(server, state, clientId);
  return server;
};
