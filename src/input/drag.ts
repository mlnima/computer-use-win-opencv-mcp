import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Point } from '../types/geometry';
import type { MouseButton } from '../types/input';
import type { RuntimeState } from '../types/runtime';
import { cancelInputOperations, type InputExecution } from './execution';
import { probeNative } from './nativeActions';
import { mouseButtonNative, movePointerNative, pointerResultNative, type PointerMoveOptions } from './pointer';
import { enqueueInput } from './queue';

export type DragBeginOptions = Point & {
  button?: MouseButton;
  durationMs?: number;
};

export type DragMoveOptions = PointerMoveOptions & {
  dragId?: string;
};

export type DragReleaseOptions = {
  dragId?: string;
  x?: number;
  y?: number;
  durationMs?: number;
};

const requireDrag = (state: RuntimeState, dragId?: string) => {
  const drag = state.drag;
  if (!drag) throw new Error('No drag is active');
  if (dragId && drag.id !== dragId) throw new Error('The drag identifier is stale');
  return drag;
};

export const beginDragNative = async (
  state: RuntimeState,
  options: DragBeginOptions,
  execution?: InputExecution
) => {
  if (state.drag) throw new Error('A drag is already active');
  const startedAt = performance.now();
  await movePointerNative(state, { x: options.x, y: options.y, durationMs: options.durationMs }, execution);
  const probe = await probeNative(state, execution);
  const button = options.button || 'left';
  await mouseButtonNative(state, button, 'down', execution);
  const drag = {
    id: randomUUID(),
    button,
    startedAt: new Date().toISOString(),
    point: { x: probe.x, y: probe.y }
  };
  state.drag = drag;
  try {
    execution?.assertActive();
    return { drag, input: await pointerResultNative(state, startedAt, execution) };
  } catch (error) {
    await cancelDragNative(state).catch(() => undefined);
    throw error;
  }
};

export const moveDragNative = async (
  state: RuntimeState,
  options: DragMoveOptions,
  execution?: InputExecution
) => {
  const startedAt = performance.now();
  const drag = requireDrag(state, options.dragId);
  try {
    await movePointerNative(state, options, execution);
    const probe = await probeNative(state, execution);
    drag.point = { x: probe.x, y: probe.y };
    execution?.assertActive();
    return { drag, input: await pointerResultNative(state, startedAt, execution) };
  } catch (error) {
    await cancelDragNative(state).catch(() => undefined);
    throw error;
  }
};

export const releaseDragNative = async (
  state: RuntimeState,
  options: DragReleaseOptions = {},
  execution?: InputExecution
) => {
  if ((options.x === undefined) !== (options.y === undefined))
    throw new Error('Drag release requires both x and y or neither coordinate');
  if (options.durationMs !== undefined && options.x === undefined)
    throw new Error('Drag release duration requires x and y coordinates');
  const startedAt = performance.now();
  const drag = requireDrag(state, options.dragId);
  try {
    execution?.assertActive();
    if (options.x !== undefined && options.y !== undefined)
      await movePointerNative(state, { x: options.x, y: options.y, durationMs: options.durationMs }, execution);
  } finally {
    await mouseButtonNative(state, drag.button, 'up');
    state.drag = undefined;
  }
  return { dragId: drag.id, input: await pointerResultNative(state, startedAt, execution) };
};

export const cancelDragNative = async (state: RuntimeState) => {
  const drag = state.drag;
  if (!drag) return;
  await mouseButtonNative(state, drag.button, 'up');
  state.drag = undefined;
};

export const beginDrag = (state: RuntimeState, options: DragBeginOptions) =>
  enqueueInput(state, (execution) => beginDragNative(state, options, execution));

export const moveDrag = (state: RuntimeState, options: DragMoveOptions) =>
  enqueueInput(state, (execution) => moveDragNative(state, options, execution));

export const releaseDrag = (state: RuntimeState, options: DragReleaseOptions = {}) =>
  enqueueInput(state, (execution) => releaseDragNative(state, options, execution));

export const cancelDrag = (state: RuntimeState) => {
  cancelInputOperations(state, 'Active drag was cancelled');
  return enqueueInput(state, () => cancelDragNative(state), { bypassControl: true });
};
