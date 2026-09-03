import { performance } from 'node:perf_hooks';
import type { Point } from '../types/geometry';
import type { InputResult, KeyMode, MouseButton } from '../types/input';
import type { RuntimeState } from '../types/runtime';
import { waitForInput, type InputExecution } from './execution';
import { getHeldInputState } from './heldState';
import { buttonNative, moveAbsoluteNative, moveRelativeNative, probeNative, wheelNative } from './nativeActions';
import { enqueueInput } from './queue';
import { delay, waitUntil } from './timing';

export type PointerMoveOptions = Point & {
  relative?: boolean;
  durationMs?: number;
  steps?: number;
};

export type ClickOptions = {
  button?: MouseButton;
  count?: number;
  intervalMs?: number;
};

export type ScrollOptions = {
  deltaX?: number;
  deltaY?: number;
};

const finiteCoordinate = (value: number, name: string) => {
  if (!Number.isFinite(value) || value < -2_147_483_648 || value > 2_147_483_647)
    throw new Error(`${name} must be a finite 32-bit coordinate`);
  return Math.round(value);
};

export const pointerResultNative = async (
  state: RuntimeState,
  startedAt: number,
  execution?: InputExecution
): Promise<InputResult> => {
  const probe = await probeNative(state, execution);
  execution?.assertActive();
  return {
    ok: true,
    cursor: { x: probe.x, y: probe.y },
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    verification: { windowHandle: probe.windowHandle }
  };
};

const normalizedDuration = (state: RuntimeState, durationMs?: number) => {
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 0))
    throw new Error('Pointer duration must be a non-negative finite number');
  return Math.max(0, Math.min(state.config.maxTimelineMs, Math.round(durationMs || 0)));
};

const pathSteps = (durationMs: number, requested?: number) => Math.max(
  1,
  Math.min(600, requested && Number.isFinite(requested) ? Math.round(requested) : Math.ceil(durationMs / 8))
);

const ease = (value: number) => value < 0.5
  ? 4 * value * value * value
  : 1 - Math.pow(-2 * value + 2, 3) / 2;

const moveAbsolutePath = async (
  state: RuntimeState,
  start: Point,
  target: Point,
  durationMs: number,
  steps: number,
  execution?: InputExecution
) => {
  const startedAt = performance.now();
  let previous = start;
  for (let index = 1; index <= steps; index += 1) {
    await waitUntil(startedAt + durationMs * index / steps, execution);
    const progress = ease(index / steps);
    const point = {
      x: Math.round(start.x + (target.x - start.x) * progress),
      y: Math.round(start.y + (target.y - start.y) * progress)
    };
    if (point.x !== previous.x || point.y !== previous.y) await moveAbsoluteNative(state, point.x, point.y, execution);
    previous = point;
  }
};

const moveRelativePath = async (
  state: RuntimeState,
  delta: Point,
  durationMs: number,
  steps: number,
  execution?: InputExecution
) => {
  const startedAt = performance.now();
  let sent = { x: 0, y: 0 };
  for (let index = 1; index <= steps; index += 1) {
    await waitUntil(startedAt + durationMs * index / steps, execution);
    const progress = ease(index / steps);
    const expected = { x: Math.round(delta.x * progress), y: Math.round(delta.y * progress) };
    const increment = { x: expected.x - sent.x, y: expected.y - sent.y };
    if (increment.x || increment.y) await moveRelativeNative(state, increment.x, increment.y, execution);
    sent = expected;
  }
};

export const movePointerNative = async (
  state: RuntimeState,
  options: PointerMoveOptions,
  execution?: InputExecution
) => {
  execution?.assertActive();
  if (options.steps !== undefined && (!Number.isFinite(options.steps) || options.steps <= 0))
    throw new Error('Pointer steps must be a positive finite number');
  const x = finiteCoordinate(options.x, 'Pointer x');
  const y = finiteCoordinate(options.y, 'Pointer y');
  const durationMs = normalizedDuration(state, options.durationMs);
  const steps = pathSteps(durationMs, options.steps);
  if (options.relative) {
    if (!x && !y) throw new Error('Relative pointer movement requires a non-zero delta');
    if (durationMs) await moveRelativePath(state, { x, y }, durationMs, steps, execution);
    else await moveRelativeNative(state, x, y, execution);
    return;
  }
  const start = await probeNative(state, execution);
  const target = { x, y };
  const screenRight = start.screen.left + start.screen.width;
  const screenBottom = start.screen.top + start.screen.height;
  if (x < start.screen.left || x >= screenRight || y < start.screen.top || y >= screenBottom)
    throw new Error(`Pointer target is outside the virtual screen (${start.screen.left},${start.screen.top})-(${screenRight - 1},${screenBottom - 1})`);
  if (durationMs) await moveAbsolutePath(state, start, target, durationMs, steps, execution);
  else await moveAbsoluteNative(state, target.x, target.y, execution);
  let cursor = await probeNative(state, execution);
  if (cursor.x !== target.x || cursor.y !== target.y) {
    await moveAbsoluteNative(state, target.x, target.y, execution);
    cursor = await probeNative(state, execution);
  }
  if (Math.abs(cursor.x - target.x) > 1 || Math.abs(cursor.y - target.y) > 1)
    throw new Error(`Pointer verification failed at ${cursor.x},${cursor.y}`);
};

export const mouseButtonNative = async (
  state: RuntimeState,
  button: MouseButton,
  mode: KeyMode,
  execution?: InputExecution
) => {
  execution?.assertActive();
  const held = getHeldInputState(state).buttons;
  if (mode === 'press') {
    if (held.has(button)) throw new Error(`Mouse button ${button} is already held`);
    held.add(button);
    await buttonNative(state, button, true, execution);
    try {
      execution?.assertActive();
    } finally {
      await buttonNative(state, button, false);
      held.delete(button);
    }
    return;
  }
  if (mode === 'down' && held.has(button)) throw new Error(`Mouse button ${button} is already held`);
  if (mode === 'down') held.add(button);
  await buttonNative(state, button, mode === 'down', execution);
  if (mode === 'up') {
    held.delete(button);
    return;
  }
  try {
    execution?.assertActive();
  } catch (error) {
    const released = await buttonNative(state, button, false).then(() => true, () => false);
    if (released) held.delete(button);
    throw error;
  }
};

export const clickPointerNative = async (
  state: RuntimeState,
  options: ClickOptions = {},
  execution?: InputExecution
) => {
  const button = options.button || 'left';
  if (options.count !== undefined && (!Number.isFinite(options.count) || options.count <= 0))
    throw new Error('Click count must be a positive finite number');
  if (options.intervalMs !== undefined && (!Number.isFinite(options.intervalMs) || options.intervalMs < 0))
    throw new Error('Click interval must be a non-negative finite number');
  const count = Math.max(1, Math.min(10, Math.round(options.count || 1)));
  const intervalMs = Math.max(0, Math.min(2_000, Math.round(options.intervalMs ?? 80)));
  for (let index = 0; index < count; index += 1) {
    execution?.assertActive();
    await mouseButtonNative(state, button, 'press', execution);
    if (index + 1 < count) execution ? await waitForInput(execution, intervalMs) : await delay(intervalMs);
  }
};

export const scrollPointerNative = async (
  state: RuntimeState,
  options: ScrollOptions,
  execution?: InputExecution
) => {
  const deltaX = finiteCoordinate(options.deltaX ?? 0, 'Horizontal wheel delta');
  const deltaY = finiteCoordinate(options.deltaY ?? 0, 'Vertical wheel delta');
  if (!deltaX && !deltaY) throw new Error('A horizontal or vertical non-zero wheel delta is required');
  await wheelNative(state, deltaX, deltaY, execution);
};

export const getPointerProbe = (state: RuntimeState) => enqueueInput(state, (execution) => probeNative(state, execution));

export const getCursorPosition = async (state: RuntimeState) => {
  const probe = await getPointerProbe(state);
  return { x: probe.x, y: probe.y };
};

export const movePointer = (state: RuntimeState, options: PointerMoveOptions) => enqueueInput(state, async (execution) => {
  const startedAt = performance.now();
  await movePointerNative(state, options, execution);
  return pointerResultNative(state, startedAt, execution);
});

export const mouseButton = (state: RuntimeState, button: MouseButton, mode: KeyMode = 'press') =>
  enqueueInput(state, async (execution) => {
    const startedAt = performance.now();
    await mouseButtonNative(state, button, mode, execution);
    return pointerResultNative(state, startedAt, execution);
  });

export const clickPointer = (state: RuntimeState, options: ClickOptions = {}) => enqueueInput(state, async (execution) => {
  const startedAt = performance.now();
  await clickPointerNative(state, options, execution);
  return pointerResultNative(state, startedAt, execution);
});

export const scrollPointer = (state: RuntimeState, options: ScrollOptions) => enqueueInput(state, async (execution) => {
  const startedAt = performance.now();
  await scrollPointerNative(state, options, execution);
  return pointerResultNative(state, startedAt, execution);
});
