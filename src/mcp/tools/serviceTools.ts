import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RuntimeState } from '../../types/runtime';
import { runInputTransaction } from '../../input/queue';
import { assertControl } from '../../runtime/control';
import { clearClipboard, readClipboard, writeClipboard } from '../../services/clipboard';
import { listFiles, manageFile, readFileResource, writeFileValue } from '../../services/files';
import { listProcesses, requestCloseProcess, shellOpen, startProcess, stopProcess } from '../../services/processes';
import { closeTerminal, createTerminal, readTerminal, resizeTerminal, writeTerminal } from '../../services/terminal';
import { addResource, resourceReference } from '../../runtime/resources';
import { runTool } from '../toolResult';

const clipboardSchema = z.object({
  action: z.enum(['read', 'write', 'clear']),
  text: z.string().optional(),
  leaseId: z.string().optional()
});

const fileSchema = z.object({
  action: z.enum(['list', 'read', 'write', 'append', 'stat', 'mkdir', 'copy', 'move', 'delete']),
  path: z.string().min(1),
  destination: z.string().optional(),
  value: z.string().optional(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(1000).default(200)
});

const processRequirements = {
  list: [], launch: ['leaseId', 'file'], open: ['leaseId', 'file'],
  close: ['leaseId', 'processId'], terminate: ['leaseId', 'processId']
} as const;

const processSchema = z.object({
  action: z.enum(['list', 'launch', 'open', 'close', 'terminate']),
  processId: z.number().int().positive().optional().describe('Required for close and terminate.'),
  file: z.string().min(1).optional().describe('Required for launch and open: executable, file path or URL.'),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  wait: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(300000).default(30000),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(2000).default(500),
  leaseId: z.string().min(1).optional().describe('Required for launch, open, close and terminate. Acquire with computer_control first.')
}).superRefine((input, context) => {
  for (const field of processRequirements[input.action]) {
    if (!input[field]) context.addIssue({ code: 'custom', path: [field], message: `${field} is required for process action ${input.action}.` });
  }
}).meta({
  anyOf: Object.entries(processRequirements).map(([action, required]) => ({ properties: { action: { const: action } }, required }))
});

const terminalRequirements = {
  create: ['leaseId'], read: ['sessionId'], write: ['sessionId', 'leaseId', 'data'],
  resize: ['sessionId', 'leaseId'], close: ['sessionId', 'leaseId']
} as const;

const terminalSchema = z.object({
  action: z.enum(['create', 'write', 'read', 'resize', 'close']),
  sessionId: z.string().min(1).optional().describe('Required for read, write, resize and close. Use the session ID returned by create.'),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  data: z.string().min(1).optional().describe('Required for write: text to send to the terminal session.'),
  from: z.number().int().nonnegative().optional(),
  maxChars: z.number().int().min(1).max(262144).default(32768),
  columns: z.number().int().min(20).max(500).default(120),
  rows: z.number().int().min(5).max(200).default(30),
  leaseId: z.string().min(1).optional().describe('Required for create, write, resize and close. Acquire with computer_control first.')
}).superRefine((input, context) => {
  for (const field of terminalRequirements[input.action]) {
    if (!input[field]) context.addIssue({ code: 'custom', path: [field], message: `${field} is required for terminal action ${input.action}.` });
  }
}).meta({
  anyOf: Object.entries(terminalRequirements).map(([action, required]) => ({ properties: { action: { const: action } }, required }))
});

const traceSchema = z.object({
  action: z.enum(['read', 'clear', 'export']),
  limit: z.number().int().min(1).max(1000).default(200)
});

const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined || value === '') throw new Error(`${name} is required for this action.`);
  return value;
};

const runDesktopMutation = async <T>(
  state: RuntimeState,
  clientId: string,
  leaseId: string | undefined,
  signal: AbortSignal,
  action: (signal: AbortSignal) => Promise<T> | T
) => {
  signal.throwIfAborted();
  const lease = await assertControl(state, clientId, required(leaseId, 'leaseId'));
  signal.throwIfAborted();
  return await runInputTransaction(state, async ({ guard, execution }) => {
    guard();
    return await action(execution.signal);
  }, { owner: { clientId, leaseId: lease.id }, signal });
};

const registerClipboard = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_clipboard', {
  title: 'Clipboard',
  description: 'Read, write, or clear the Windows clipboard.',
  inputSchema: clipboardSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ action, text, leaseId }, extra) => runTool(async () => {
  if (action === 'read') return { text: await readClipboard(extra.signal) };
  if (action === 'write') return await runDesktopMutation(state, clientId, leaseId, extra.signal, (signal) =>
    writeClipboard(required(text, 'text'), signal));
  return await runDesktopMutation(state, clientId, leaseId, extra.signal, clearClipboard);
}));

const registerFiles = (server: McpServer, state: RuntimeState) => server.registerTool('computer_files', {
  title: 'Files',
  description: 'List, read, write, append, inspect, create, copy, move, or delete files and directories.',
  inputSchema: fileSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ action, path, destination, value, encoding, offset, limit }, extra) => runTool(async () => {
  if (action === 'list') return await listFiles(path, offset, limit, extra.signal);
  if (action === 'read') return await readFileResource(state, path, encoding, extra.signal);
  if (action === 'write' || action === 'append') return await writeFileValue(path, required(value, 'value'), encoding, action === 'append', extra.signal);
  return await manageFile(action, path, destination, extra.signal);
}));

const registerProcesses = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_process', {
  title: 'Processes and applications',
  description: 'List, launch, shell-open, request close, or terminate Windows processes. Every action except list requires leaseId from computer_control acquire. Launch/open also require file; close/terminate require processId.',
  inputSchema: processSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ action, processId, file, args, cwd, wait, timeoutMs, query, limit, leaseId }, extra) => runTool(async () => {
  if (action === 'list') return await listProcesses(query, limit, extra.signal);
  if (action === 'launch') {
    const launched = await runDesktopMutation(state, clientId, leaseId, extra.signal, (signal) =>
      startProcess(required(file, 'file'), args, cwd, wait, timeoutMs, signal, extra.signal));
    return { processId: launched.processId, ...await launched.completion };
  }
  if (action === 'open') return await runDesktopMutation(state, clientId, leaseId, extra.signal, (signal) =>
    shellOpen(required(file, 'file'), signal));
  if (action === 'close') return await runDesktopMutation(state, clientId, leaseId, extra.signal, (signal) =>
    requestCloseProcess(required(processId, 'processId'), signal));
  return await runDesktopMutation(state, clientId, leaseId, extra.signal, (signal) =>
    stopProcess(required(processId, 'processId'), true, signal));
}));

const registerTerminal = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_terminal', {
  title: 'Terminal',
  description: 'Create and control persistent ConPTY terminal sessions.',
  inputSchema: terminalSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ action, sessionId, shell, cwd, data, from, maxChars, columns, rows, leaseId }, extra) => runTool(async () => {
  if (action === 'create') return await runDesktopMutation(state, clientId, leaseId, extra.signal, (signal) =>
    createTerminal(state, shell, cwd, columns, rows, signal));
  const id = required(sessionId, 'sessionId');
  if (action === 'read') return readTerminal(state, id, from, maxChars, extra.signal);
  return await runDesktopMutation(state, clientId, leaseId, extra.signal, async (signal) => {
    if (action === 'write') return await writeTerminal(state, id, required(data, 'data'), signal);
    if (action === 'resize') return await resizeTerminal(state, id, columns, rows, signal);
    return await closeTerminal(state, id, signal);
  });
}));

const registerTrace = (server: McpServer, state: RuntimeState) => server.registerTool('computer_trace', {
  title: 'Diagnostics trace',
  description: 'Read, clear, or export bounded perception and input diagnostics.',
  inputSchema: traceSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ action, limit }, extra) => runTool(async () => {
  if (action === 'clear') {
    extra.signal.throwIfAborted();
    state.trace.length = 0;
    return { cleared: true };
  }
  extra.signal.throwIfAborted();
  const events = state.trace.slice(-limit);
  if (action === 'read') return { events };
  extra.signal.throwIfAborted();
  const resource = addResource(state, { name: 'trace.json', mimeType: 'application/json', text: JSON.stringify(events, null, 2), category: 'traces' });
  return { resource: resourceReference(resource), eventCount: events.length };
}));

export const registerServiceTools = (server: McpServer, state: RuntimeState, clientId: string) => {
  registerClipboard(server, state, clientId);
  registerFiles(server, state);
  registerProcesses(server, state, clientId);
  registerTerminal(server, state, clientId);
  registerTrace(server, state);
};
