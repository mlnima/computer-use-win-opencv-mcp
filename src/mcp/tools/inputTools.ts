import { performance } from 'node:perf_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bindDragDestination, preflightDragDestination, verifyDragDestination } from '../../actions/dragDestination';
import { performGroundedAccessibilityAction } from '../../actions/groundedAccessibility';
import { requireElement, requireObservation, scrollPoint, targetPoint, verifyInputSurface } from '../../actions/observations';
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
import { createPostObservation } from '../../observation/post';
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
    description: 'Resolve a fresh grounded element, focus its window, move physically and return a one-use commit ID. Check the hover image before committing: if the requested UI change already happened, observe again instead of clicking the old target. Element IDs belong only to their observation.',
    inputSchema: preparePointerSchema,
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, ({ leaseId, ...options }, extra) => runTool(async () => {
    const lease = await assertControl(state, clientId, leaseId);
    return await prepareGroundedPointer(state, options, { clientId, leaseId: lease.id, signal: extra.signal });
  }, state));
  server.registerTool('computer_pointer_commit', {
    title: 'Commit verified pointer action',
    description: 'Consume a short-lived prepared target for click, multi-click, alternate-button click, or scrolling.',
    inputSchema: commitPointerSchema,
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, ({ leaseId, ...options }, extra) => runTool(async () => {
    const lease = await assertControl(state, clientId, leaseId);
    return await commitGroundedPointer(state, options, { clientId, leaseId: lease.id, signal: extra.signal });
  }, state));
};

const registerRawPointer = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_pointer', {
  title: 'Direct and relative pointer input',
  description: 'Physical or relative pointer input. Scroll within an observed region or element, including normal UI controls; with no x/y, move to its center or safe point first. Clicks and held input require a canvas surface and reject actionable controls. Use prepare/commit for UI clicks.',
  inputSchema: rawPointerSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ leaseId, surface, action, x, y, relative, durationMs, steps, button, mode, count, intervalMs, deltaX, deltaY }, extra) => runTool(async () => {
  const lease = await assertControl(state, clientId, leaseId);
  const point = scrollPoint(state, surface, { action, x, y, relative });
  recordTrace(state, 'pointer.direct', { action, relative, button, mode, count });
  return await runInputTransaction(state, async ({ execution }) => {
    if (state.drag) throw new Error('An active grounded drag monopolizes pointer input until released or cancelled.');
    const startedAt = performance.now();
    execution.pointerGuard = await verifyInputSurface(state, surface, { ...point, button, mode, deltaX, deltaY }, execution);
    if (point.x !== undefined && point.y !== undefined) await movePointerNative(state, { x: point.x, y: point.y, relative: point.relative, durationMs, steps }, execution);
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
  description: 'Batch timestamped input for drawing, scrolling or keyboard input. Wheel-only pointer sequences may scroll normal UI controls inside the observed surface. Move inside that surface before wheeling; keep points 8 screen pixels inside it. Use prepare/commit for UI clicks.',
  inputSchema: timelineSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ leaseId, surface, events, keyMethod, preserveHeld, windowHandle }, extra) => runTool(async () => {
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
      execution.pointerGuard = await verifyInputSurface(state, surface, events, execution);
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
    description: 'Move an active held-button drag to a fresh grounded destination, screen point, or relative delta and optionally capture while held. With relative true, an omitted x or y is zero.',
    inputSchema: dragMoveSchema,
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, ({ leaseId, dragId, observationId, token, elementId, x, y, screenCoordinates, relative, allowRaw, durationMs, hoverScreenshot }, extra) => runTool(async () => {
    const lease = await assertControl(state, clientId, leaseId);
    requireDragOwner(state, clientId, lease.id, dragId);
    const observation = observationId ? requireObservation(state, observationId, required(token, 'token')) : undefined;
    const destination = observation
      ? targetPoint(observation, { elementId, x, y, allowRaw }).screen
      : relative ? { x: x ?? 0, y: y ?? 0 } : { x: required(x, 'x'), y: required(y, 'y') };
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
    const hover = hoverScreenshot ? await createPostObservation(state, { target: expectedWindow ? 'window' : 'foreground', windowHandle: expectedWindow?.handle, includeCursor: true, signal: extra.signal }).catch(() => undefined) : undefined;
    return { ...result, hover, coordinateSpace: observation ? 'observation' : screenCoordinates ? 'screen' : 'relative' };
  }, state));
  server.registerTool('computer_drag_release', {
    title: 'Release drag',
    description: 'Verify the current grounded destination, release the held drag button, and optionally capture the result.',
    inputSchema: dragReleaseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, ({ leaseId, dragId, observeAfter, inlineImage }, extra) => runTool(async () => {
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
    const post = observeAfter ? await createPostObservation(state, { target: 'foreground', includeCursor: true, signal: extra.signal }, inlineImage).catch(() => undefined) : undefined;
    return { ...result, post };
  }, state));
};

const registerAccessibility = (server: McpServer, state: RuntimeState, clientId: string) => server.registerTool('computer_accessibility', {
  title: 'UI Automation action',
  description: 'Invoke, focus, set, toggle, select, expand, or collapse an accessible element. scroll requires value up/down/left/right on a container supporting scroll. scrollIntoView reveals an item; it does not scroll a container by a direction.',
  inputSchema: accessibilitySchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, ({ leaseId, observationId, token, elementId, windowHandle, runtimeId, action, value, observeAfter, inlineImage }, extra) => runTool(async () => {
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
  const post = observeAfter ? await createPostObservation(state, { target: 'window', windowHandle: handle, includeCursor: true, signal: extra.signal }, inlineImage).catch(() => undefined) : undefined;
  return { action, windowHandle: handle, runtimeId: id, result, post };
}, state));

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
