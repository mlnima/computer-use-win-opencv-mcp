import process from 'node:process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { releaseHeldInputs } from '../../input/cleanup';
import { getInputCapabilities } from '../../input/capabilities';
import { getHeldInputState } from '../../input/heldState';
import { runInputTransaction } from '../../input/queue';
import { acquireLease, assertControl, cancelControlInput, controlStatus, releaseLease, renewLease } from '../../runtime/control';
import type { RuntimeState } from '../../types/runtime';
import type { WindowInfo } from '../../types/geometry';
import { listMonitors } from '../../windows/monitors';
import { controlWindow, getWindow, listWindows } from '../../windows/windows';
import { runTool } from '../toolResult';
import { nativeCaptureSupport } from '../../capture/capture';

const boundsSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number()
});

const targetsSchema = z.object({
  action: z.enum(['list', 'focus', 'restore', 'minimize', 'maximize', 'move', 'resize', 'close']).default('list'),
  windowHandle: z.string().optional(),
  bounds: boundsSchema.optional(),
  leaseId: z.string().optional()
});

const controlSchema = z.object({
  action: z.enum(['status', 'acquire', 'renew', 'release', 'pause', 'resume', 'emergencyStop', 'releaseInput']),
  leaseId: z.string().optional(),
  owner: z.string().max(200).optional(),
  ttlMs: z.number().int().min(1000).max(300000).default(30000)
});

const required = (value: string | undefined, name: string) => {
  if (!value) throw new Error(`${name} is required for this action.`);
  return value;
};

const registerStatus = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_status', {
  title: 'Computer-use capabilities',
  description: 'Report transport-independent capture, grounding, model, input, and runtime capabilities.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true }
}, (_input, extra) => runTool(async () => {
  const held = getHeldInputState(state);
  const input = await getInputCapabilities(state, extra.signal).catch((error) => {
    extra.signal.throwIfAborted();
    return { error: error instanceof Error ? error.message : String(error) };
  });
  extra.signal.throwIfAborted();
  const capture = await nativeCaptureSupport(extra.signal);
  extra.signal.throwIfAborted();
  const control = await controlStatus(state, clientId);
  extra.signal.throwIfAborted();
  return {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    windows: process.platform === 'win32',
    capture,
    perception: {
      uiAutomation: process.platform === 'win32',
      openCv: state.config.openCvEnabled,
      ocr: state.config.ocrEnabled,
      ocrLanguages: state.config.ocrLanguages,
      visionConfigured: Boolean(state.config.visionApiUrl && state.config.visionModel)
    },
    input: {
      ...input,
      heldButtons: [...held.buttons],
      heldKeys: [...held.keys.keys()],
      drag: state.drag ? {
        id: state.drag.id,
        button: state.drag.button,
        startedAt: state.drag.startedAt,
        point: state.drag.point,
        ownedByClient: state.drag.clientId === clientId
      } : undefined
    },
    http: { host: state.config.host, port: state.config.port, placeholderToken: state.config.authToken === 'change.me' },
    control,
    resources: state.resources.size,
    observations: state.observations.size
  };
}));

const registerTargets = (server: McpServer, state: RuntimeState, clientId: string) => {
  const knownWindows = new Map<string, WindowInfo>();
  return server.registerTool('computer_targets', {
    title: 'Windows and monitors',
    description: 'List display targets or focus, restore, minimize, maximize, move, resize, or close a window. Close requires a previously listed or observed window; an already disappeared window returns already_closed.',
    inputSchema: targetsSchema,
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, ({ action, windowHandle, bounds, leaseId }, extra) => runTool(async () => {
    if (action === 'list') {
      const [windows, monitors] = await Promise.all([listWindows(extra.signal, true), listMonitors(extra.signal)]);
      for (const window of windows) {
        knownWindows.delete(window.handle);
        knownWindows.set(window.handle, window);
      }
      while (knownWindows.size > 1000) knownWindows.delete(knownWindows.keys().next().value!);
      return { windows, monitors };
    }
    const handle = required(windowHandle, 'windowHandle');
    const expected = knownWindows.get(handle) || [...state.observations.values()].reverse().find((observation) => observation.window?.handle === handle)?.window;
    const recovery = { tool: 'computer_targets', arguments: { action: 'list' } };
    if (action === 'close' && !expected) return { action, windowHandle: handle, status: 'target_unobserved', recovery };
    const lease = await assertControl(state, clientId, leaseId);
    const status = await runInputTransaction(state, async ({ guard, execution }) => {
      guard();
      const result = await controlWindow(handle, action, bounds, execution.signal, expected);
      guard();
      return result;
    }, { owner: { clientId, leaseId: lease.id }, signal: extra.signal });
    return { action, windowHandle: handle, status, window: status === 'already_closed' ? null : await getWindow(handle, extra.signal), ...(status === 'target_changed' ? { recovery } : {}) };
  }));
};

const registerControl = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_control', {
  title: 'Computer control state',
  description: 'Coordinate exclusive input, pause or resume actions, emergency-stop, and release held input.',
  inputSchema: controlSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ action, leaseId, owner, ttlMs }, extra) => runTool(async () => {
  if (action === 'status') {
    extra.signal.throwIfAborted();
    return await controlStatus(state, clientId);
  }
  if (action === 'acquire') return await acquireLease(state, clientId, owner, ttlMs, extra.signal);
  if (action === 'renew') return await renewLease(state, clientId, required(leaseId, 'leaseId'), ttlMs, extra.signal);
  if (action === 'release') return await releaseLease(state, clientId, required(leaseId, 'leaseId'));
  if (action === 'pause') {
    state.control.paused = true;
    await cancelControlInput(state, 'Computer control paused');
  }
  if (action === 'resume') {
    state.control.paused = false;
    state.control.emergencyStopped = false;
  }
  if (action === 'emergencyStop') {
    state.control.emergencyStopped = true;
    state.control.paused = true;
    await cancelControlInput(state, 'Emergency stop requested', { clearLease: true });
  }
  if (action === 'releaseInput') state.preparedPointers.clear();
  const released = action === 'releaseInput' ? await releaseHeldInputs(state, { bypassControl: true }) : undefined;
  return { action, released, control: await controlStatus(state, clientId) };
}));

export const registerSystemTools = (server: McpServer, state: RuntimeState, clientId: string) => {
  registerStatus(server, state, clientId);
  registerTargets(server, state, clientId);
  registerControl(server, state, clientId);
};
