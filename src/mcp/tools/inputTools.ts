import { performance } from 'node:perf_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bindDragDestination, preflightDragDestination, verifyDragDestination } from '../../actions/dragDestination';
import { performGroundedAccessibilityAction } from '../../actions/groundedAccessibility';
import { compactObservation, requireElement, requireObservation, targetPoint } from '../../actions/observations';
import { commitGroundedPointer, consumeGroundedPointer, prepareGroundedPointer } from '../../actions/groundedPointer';
import { releaseHeldInputs } from '../../input/cleanup';
import { beginDragNative, cancelDragNative, moveDragNative, releaseDragNative } from '../../input/drag';
import { keyboardInputNative, keyboardKeyNative, typeUnicodeTextNative } from '../../input/keyboard';
import { probeNative } from '../../input/nativeActions';
import {
  clickPointerNative,
  mouseButtonNative,
  movePointerNative,
  pointerResultNative,
  scrollPointerNative
} from '../../input/pointer';
import { runInputTransaction } from '../../input/queue';
import { runInputTimeline } from '../../input/timeline';
import { createObservation } from '../../observation/create';
import { assertControl } from '../../runtime/control';
import { recordTrace } from '../../runtime/state';
import type { RuntimeState } from '../../types/runtime';
import { focusWindow } from '../../windows/windows';
import {
  accessibilitySchema,
  commitPointerSchema,
  dragBeginSchema,
  dragMoveSchema,
  dragReleaseSchema,
  keyboardSchema,
  preparePointerSchema,
  rawPointerSchema,
  timelineSchema
} from '../schemas/inputSchemas';
import { runTool } from '../toolResult';

const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined || value === '') throw new Error(`${name} is required for this action.`);
  return value;
};

const fastObservation = async (state: RuntimeState, windowHandle?: string, signal?: AbortSignal) => {
  const observation = await createObservation(state, {
    target: windowHandle ? 'window' : 'foreground',
    windowHandle,
    includeCursor: true,
    includeAccessibility: false,
    includeOcr: false,
    includeOpenCv: false,
    signal
  });
  return { ...compactObservation(observation), screenshotUri: observation.screenshotUri };
};

const focusTarget = async (windowHandle: string | undefined, guard: () => void, signal?: AbortSignal) => {
  if (!windowHandle) return;
  await focusWindow(windowHandle, signal);
  guard();
};

const requireDragOwner = (state: RuntimeState, clientId: string, leaseId: string, dragId: string) => {
  const drag = state.drag;
  if (!drag || drag.id !== dragId) throw new Error('The drag identifier is stale or no drag is active.');
  if (drag.clientId !== clientId || drag.leaseId !== leaseId) throw new Error('The active drag belongs to another client or input lease.');
  return drag;
};
const publicDrag = (drag: NonNullable<RuntimeState['drag']>) => ({
  id: drag.id,
  button: drag.button,
  startedAt: drag.startedAt,
  point: drag.point,
  destinationWindowHandle: drag.destinationWindowHandle
});

const cancelUnsafeDrag = async (state: RuntimeState, execution: Parameters<typeof keyboardKeyNative>[5]) => {
  await keyboardKeyNative(state, 'Escape', 'press', 'virtual-key', 0, execution).catch(() => undefined);
  await cancelDragNative(state).catch(() => undefined);
};

const registerPreparedPointer = (server: McpServer, state: RuntimeState, clientId: string) => {
  server.registerTool('computer_pointer_prepare', {
    title: 'Prepare verified pointer action',
    description: 'Resolve a fresh grounded element, focus its window, move physically, verify the hit target, and return a one-use commit ID.',
    inputSchema: preparePointerSchema,
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, ({ leaseId, ...options }, extra) => runTool(async () => {
    const lease = await assertControl(state, clientId, leaseId);
    return await prepareGroundedPointer(state, options, { clientId, leaseId: lease.id, signal: extra.signal });
  }));
  server.registerTool('computer_pointer_commit', {
    title: 'Commit verified pointer action',
    description: 'Consume a short-lived prepared target for click, multi-click, alternate-button click, or scrolling.',
    inputSchema: commitPointerSchema,
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, ({ leaseId, ...options }, extra) => runTool(async () => {
    const lease = await assertControl(state, clientId, leaseId);
    return await commitGroundedPointer(state, options, { clientId, leaseId: lease.id, signal: extra.signal });
  }));
};

const registerRawPointer = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_pointer', {
  title: 'Direct and relative pointer input',
  description: 'Move, click, hold/release buttons, or scroll using physical screen coordinates or relative deltas for 3D/game control.',
  inputSchema: rawPointerSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ leaseId, action, x, y, relative, durationMs, steps, button, mode, count, intervalMs, deltaX, deltaY }, extra) => runTool(async () => {
  const lease = await assertControl(state, clientId, leaseId);
  if ((x === undefined) !== (y === undefined)) throw new Error('Pointer input requires both x and y or neither coordinate.');
  if (action === 'move' && x === undefined) throw new Error('x and y are required for pointer movement.');
  if (relative && x === undefined) throw new Error('Relative pointer input requires x and y deltas.');
  recordTrace(state, 'pointer.direct', { action, relative, button, mode, count });
  return await runInputTransaction(state, async ({ execution }) => {
    if (state.drag) throw new Error('An active grounded drag monopolizes pointer input until released or cancelled.');
    const startedAt = performance.now();
    if (x !== undefined && y !== undefined) await movePointerNative(state, { x, y, relative, durationMs, steps }, execution);
    if (action === 'click') await clickPointerNative(state, { button, count, intervalMs }, execution);
    if (action === 'button') await mouseButtonNative(state, button, mode, execution);
    if (action === 'scroll') await scrollPointerNative(state, { deltaX, deltaY }, execution);
    return await pointerResultNative(state, startedAt, execution);
  }, { deadlineMs: state.config.maxTimelineMs + 1_000, owner: { clientId, leaseId: lease.id }, signal: extra.signal });
}));
const registerKeyboard = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_keyboard', {
  title: 'Keyboard input',
  description: 'Send Unicode text, virtual-key or scan-code presses, chords, and persistent key-down/key-up input.',
  inputSchema: keyboardSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ leaseId, action, key, keys, text, mode, method, holdMs, intervalMs, windowHandle }, extra) => runTool(async () => {
  const lease = await assertControl(state, clientId, leaseId);
  recordTrace(state, 'keyboard', {
    action,
    keyCount: action === 'key' ? 1 : keys?.length || 0,
    textLength: action === 'text' ? text?.length || 0 : 0,
    mode,
    method,
    windowHandle
  });
  return await runInputTransaction(state, async ({ guard, execution }) => {
    const startedAt = performance.now();
    await focusTarget(windowHandle, guard, execution.signal);
    if (action === 'text') await typeUnicodeTextNative(state, { text: required(text, 'text'), intervalMs }, execution);
    else {
      const names = action === 'key' ? required(key, 'key') : required(keys, 'keys');
      await keyboardInputNative(state, { keys: names, mode, method, holdMs }, execution);
    }
    return await pointerResultNative(state, startedAt, execution);
  }, { deadlineMs: state.config.maxTimelineMs + 1_000, owner: { clientId, leaseId: lease.id }, signal: extra.signal });
}));

const registerTimeline = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_input_timeline', {
  title: 'Timed input sequence',
  description: 'Batch a bounded timestamped sequence of relative/absolute mouse, scan-code key, text, button, and wheel events for drawing, 3D, games, or other ordered input.',
  inputSchema: timelineSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ leaseId, events, keyMethod, preserveHeld, windowHandle }, extra) => runTool(async () => {
  const lease = await assertControl(state, clientId, leaseId);
  recordTrace(state, 'input.timeline', {
    eventCount: events.length,
    eventTypes: [...new Set(events.map((event) => event.type))],
    keyMethod,
    preserveHeld,
    windowHandle
  });
  return await runInputTimeline(state, {
    events,
    keyMethod,
    preserveHeld,
    before: async (execution) => {
      if (state.drag) throw new Error('An active grounded drag monopolizes pointer input until released or cancelled.');
      await focusTarget(windowHandle, execution.assertActive, execution.signal);
    }
  }, { owner: { clientId, leaseId: lease.id }, signal: extra.signal });
}));

const registerDrag = (server: McpServer, state: RuntimeState, clientId: string) => {
  server.registerTool('computer_drag_begin', {
    title: 'Begin grounded drag',
    description: 'Consume a fully verified prepared pointer target and press a mouse button without releasing it.',
    inputSchema: dragBeginSchema,
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, ({ leaseId, prepareId, button }, extra) => runTool(async () => {
    const lease = await assertControl(state, clientId, leaseId);
    const consumed = await consumeGroundedPointer(state, prepareId, { clientId, leaseId: lease.id, signal: extra.signal }, async (prepared, execution) => {
      const result = await beginDragNative(state, { ...prepared.target, button }, execution);
      Object.assign(result.drag, { clientId, leaseId: lease.id });
      return { drag: publicDrag(result.drag), input: result.input };
    });
    return { ...consumed.result, visualDifference: consumed.visualDifference, hitWindow: consumed.hitWindow };
  }));
  server.registerTool('computer_drag_move', {
    title: 'Move active drag',
    description: 'Move an active held-button drag to a fresh grounded destination, screen point, or relative delta and optionally capture while held.',
    inputSchema: dragMoveSchema,
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, ({ leaseId, dragId, observationId, token, elementId, x, y, screenCoordinates, relative, allowRaw, durationMs, hoverScreenshot }, extra) => runTool(async () => {
    const lease = await assertControl(state, clientId, leaseId);
    requireDragOwner(state, clientId, lease.id, dragId);
    const observation = observationId ? requireObservation(state, observationId, required(token, 'token')) : undefined;
    if (!observation && !screenCoordinates && !relative) throw new Error('Set screenCoordinates or relative for an ungrounded drag destination.');
    if (screenCoordinates && relative) throw new Error('A drag destination cannot be both screen and relative coordinates.');
    const destination = observation
      ? targetPoint(observation, { elementId, x, y, allowRaw }).screen
      : { x: required(x, 'x'), y: required(y, 'y') };
    const expectedWindow = observation?.window;
    const element = observation && elementId ? requireElement(observation, elementId) : undefined;
    const result = await runInputTransaction(state, async ({ execution }) => {
      const prepared = await preflightDragDestination(state, { observation, element, point: destination }, execution);
      const moved = await moveDragNative(state, { dragId, ...destination, relative: observation ? false : relative, durationMs }, execution);
      try {
        await bindDragDestination(state, moved.drag, prepared, execution);
      } catch (error) {
        await cancelUnsafeDrag(state, execution);
        throw error;
      }
      return { drag: publicDrag(moved.drag), input: moved.input, snapshotDifference: prepared.snapshotDifference };
    }, { deadlineMs: state.config.maxTimelineMs + 1_000, owner: { clientId, leaseId: lease.id }, signal: extra.signal });
    const hover = hoverScreenshot ? await fastObservation(state, expectedWindow?.handle, extra.signal).catch(() => undefined) : undefined;
    return { ...result, hover, coordinateSpace: observation ? 'observation' : screenCoordinates ? 'screen' : 'relative' };
  }));
  server.registerTool('computer_drag_release', {
    title: 'Release drag',
    description: 'Verify the current grounded destination, release the held drag button, and optionally capture the result.',
    inputSchema: dragReleaseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, ({ leaseId, dragId, observeAfter }, extra) => runTool(async () => {
    const lease = await assertControl(state, clientId, leaseId);
    const drag = requireDragOwner(state, clientId, lease.id, dragId);
    const result = await runInputTransaction(state, async ({ execution }) => {
      let verification: Awaited<ReturnType<typeof verifyDragDestination>>;
      try {
        const probe = await probeNative(state, execution);
        if (Math.abs(probe.x - drag.point.x) > 2 || Math.abs(probe.y - drag.point.y) > 2) {
          throw new Error('Pointer moved after the last verified drag step.');
        }
        verification = await verifyDragDestination(state, drag, execution);
        const finalProbe = await probeNative(state, execution);
        if (Math.abs(finalProbe.x - drag.point.x) > 2 || Math.abs(finalProbe.y - drag.point.y) > 2) {
          throw new Error('Pointer moved during drag release verification.');
        }
      } catch (error) {
        await cancelUnsafeDrag(state, execution);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail} Escape cancellation was attempted.`);
      }
      return { ...await releaseDragNative(state, { dragId }, execution), verification };
    }, { owner: { clientId, leaseId: lease.id }, signal: extra.signal });
    const post = observeAfter ? await fastObservation(state, undefined, extra.signal).catch(() => undefined) : undefined;
    return { ...result, post };
  }));
};

const registerAccessibility = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_accessibility', {
  title: 'UI Automation action',
  description: 'Invoke, focus, set, toggle, select, expand, collapse, or scroll an accessible element without coordinate guessing.',
  inputSchema: accessibilitySchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ leaseId, observationId, token, elementId, windowHandle, runtimeId, action, value, observeAfter }, extra) => runTool(async () => {
  const lease = await assertControl(state, clientId, leaseId);
  const observation = observationId ? requireObservation(state, observationId, required(token, 'token')) : undefined;
  const element = observation && elementId ? requireElement(observation, elementId) : undefined;
  const handle = observation?.window?.handle || required(windowHandle, 'windowHandle');
  const id = element?.uiaRuntimeId || required(runtimeId, 'runtimeId');
  const result = await runInputTransaction(state, async ({ guard, execution }) => await performGroundedAccessibilityAction({
    observation,
    element,
    handle,
    runtimeId: id,
    action,
    value: value || ''
  }, guard, execution), { deadlineMs: 25_000, owner: { clientId, leaseId: lease.id }, signal: extra.signal });
  const post = observeAfter ? await fastObservation(state, handle, extra.signal).catch(() => undefined) : undefined;
  return { action, windowHandle: handle, runtimeId: id, result, post };
}));

const registerRelease = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_release_input', {
  title: 'Release held input',
  description: 'Release every key and mouse button held by the active input lease and clear an active drag.',
  inputSchema: z.object({ leaseId: z.string().optional() }),
  annotations: { readOnlyHint: false, destructiveHint: false }
}, ({ leaseId }, extra) => runTool(async () => {
  const lease = await assertControl(state, clientId, leaseId);
  for (const [id, prepared] of state.preparedPointers) if (prepared.clientId === clientId) state.preparedPointers.delete(id);
  return await releaseHeldInputs(state, { bypassControl: true, owner: { clientId, leaseId: lease.id }, signal: extra.signal });
}));

export const registerInputTools = (server: McpServer, state: RuntimeState, clientId: string) => {
  registerPreparedPointer(server, state, clientId);
  registerRawPointer(server, state, clientId);
  registerKeyboard(server, state, clientId);
  registerTimeline(server, state, clientId);
  registerDrag(server, state, clientId);
  registerAccessibility(server, state, clientId);
  registerRelease(server, state, clientId);
};
