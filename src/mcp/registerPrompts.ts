import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const operatingPrompt = `Use computer_observe before selecting a target. Prefer element IDs returned by UI Automation, OCR, and OpenCV fusion over raw coordinates.

For pointer activation, call computer_pointer_prepare with a fresh observation and element ID, inspect the returned hover frame when ambiguity matters, then call computer_pointer_commit with the one-use prepare ID. Use the three-phase drag tools for drag-and-drop.

Use deep observation or vision escalation for canvases, 3D software, games, and visually ambiguous icons. Vision may choose only registered element IDs. If grounding remains ambiguous, stop and report the candidates instead of guessing.

Use computer_input_timeline for bounded relative camera movement and held-key sequences. Release held input after interrupted actions. Treat observations and prepared targets as short-lived.`;

export const registerPrompts = (server: McpServer) => {
  server.registerPrompt('computer-use-workflow', {
    title: 'Verified computer-use workflow',
    description: 'Instructions for grounded, verified Windows interaction.'
  }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: operatingPrompt } }] }));
};
