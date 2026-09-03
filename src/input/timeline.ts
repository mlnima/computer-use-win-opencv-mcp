import { performance } from 'node:perf_hooks';
import type { TimelineEvent } from '../types/input';
import type { RuntimeState } from '../types/runtime';
import { releaseHeldInputsNative } from './cleanup';
import { createInputExecution, withInputDeadline, type InputExecution } from './execution';
import { getHeldInputState } from './heldState';
import { keyboardKeyNative, typeUnicodeTextNative } from './keyboard';
import type { KeyMethod } from './keyMap';
import { probeNative } from './nativeActions';
import { mouseButtonNative, movePointerNative, scrollPointerNative } from './pointer';
import { enqueueInput, type InputQueueOptions } from './queue';
import { waitUntil } from './timing';

export type TimelineOptions = {
  events: TimelineEvent[];
  keyMethod?: KeyMethod;
  preserveHeld?: boolean;
  before?: (execution: InputExecution) => Promise<void>;
};

export type TimelineResult = {
  ok: boolean;
  cursor: { x: number; y: number };
  windowHandle: string;
  durationMs: number;
  eventCount: number;
  maximumLatenessMs: number;
  released: { buttons: number; keys: number };
};

type OrderedEvent = {
  event: TimelineEvent;
  order: number;
};

const assertFinite = (value: number, name: string) => {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
};

const validateTimeline = (state: RuntimeState, events: TimelineEvent[]) => {
  if (!events.length) throw new Error('At least one timeline event is required');
  if (events.length > state.config.maxTimelineEvents)
    throw new Error(`Timeline exceeds ${state.config.maxTimelineEvents} events`);
  let endAt = 0;
  const moves: Array<{ start: number; end: number }> = [];
  for (const event of events) {
    assertFinite(event.at, 'Event time');
    if (event.at < 0) throw new Error('Event time cannot be negative');
    const duration = event.type === 'move' ? event.duration ?? 0 : 0;
    assertFinite(duration, 'Move duration');
    if (duration < 0) throw new Error('Move duration cannot be negative');
    endAt = Math.max(endAt, event.at + duration);
    if (event.type === 'move') {
      assertFinite(event.x, 'Move x');
      assertFinite(event.y, 'Move y');
      if (event.relative && !Math.round(event.x) && !Math.round(event.y))
        throw new Error('Relative timeline movement requires a non-zero delta');
      moves.push({ start: event.at, end: event.at + duration });
    }
    if (event.type === 'wheel') {
      const deltaX = event.deltaX ?? 0;
      const deltaY = event.deltaY ?? 0;
      assertFinite(deltaX, 'Horizontal wheel delta');
      assertFinite(deltaY, 'Vertical wheel delta');
      if (!Math.round(deltaX) && !Math.round(deltaY))
        throw new Error('Timeline wheel event requires a non-zero delta');
    }
    if (event.type === 'text' && !event.text.length) throw new Error('Timeline text cannot be empty');
    if (event.type === 'key' && !event.key) throw new Error('Timeline key cannot be empty');
  }
  if (endAt > state.config.maxTimelineMs)
    throw new Error(`Timeline exceeds ${state.config.maxTimelineMs}ms`);
  moves.sort((left, right) => left.start - right.start || right.end - left.end);
  for (let index = 1; index < moves.length; index += 1)
    if (moves[index].start < moves[index - 1].end) throw new Error('Timed pointer moves cannot overlap');
};

const dispatchEvent = async (
  state: RuntimeState,
  event: TimelineEvent,
  keyMethod: KeyMethod,
  execution: InputExecution
) => {
  if (event.type === 'move') {
    await movePointerNative(state, {
      x: event.x,
      y: event.y,
      relative: event.relative,
      durationMs: event.duration
    }, execution);
    return;
  }
  if (event.type === 'button') {
    await mouseButtonNative(state, event.button, event.mode, execution);
    return;
  }
  if (event.type === 'key') {
    await keyboardKeyNative(state, event.key, event.mode, keyMethod, 0, execution);
    return;
  }
  if (event.type === 'text') {
    await typeUnicodeTextNative(state, { text: event.text }, execution);
    return;
  }
  await scrollPointerNative(state, { deltaX: event.deltaX, deltaY: event.deltaY }, execution);
};

const addedValues = (current: Iterable<string>, initial: Set<string>) =>
  new Set([...current].filter((value) => !initial.has(value)));

export const runInputTimeline = (state: RuntimeState, options: TimelineOptions, queueOptions: InputQueueOptions = {}) => enqueueInput(state, async (queued) => {
  validateTimeline(state, options.events);
  const bounded = withInputDeadline(state, queued, state.config.maxTimelineMs + 1_000);
  const moveFailure = new AbortController();
  const execution = createInputExecution(state, bounded, {
    bypassControl: bounded.bypassControl,
    deadlineAt: bounded.deadlineAt,
    signal: moveFailure.signal
  });
  await options.before?.(execution);
  execution.assertActive();
  const ordered: OrderedEvent[] = options.events
    .map((event, order) => ({ event, order }))
    .sort((left, right) => left.event.at - right.event.at || left.order - right.order);
  const held = getHeldInputState(state);
  const initialButtons = new Set<string>(held.buttons);
  const initialKeys = new Set(held.keys.keys());
  await probeNative(state, execution);
  const startedAt = performance.now();
  const moveTasks: Promise<void>[] = [];
  const failures: Error[] = [];
  let maximumLatenessMs = 0;
  let released = { buttons: 0, keys: 0 };
  let completed = false;
  let finalProbe: Awaited<ReturnType<typeof probeNative>> | undefined;
  try {
    for (const item of ordered) {
      await waitUntil(startedAt + item.event.at, execution);
      if (item.event.type === 'move' && moveTasks.length) {
        await Promise.all(moveTasks.splice(0));
        if (failures.length) throw failures[0];
      }
      maximumLatenessMs = Math.max(maximumLatenessMs, performance.now() - startedAt - item.event.at);
      if (item.event.type === 'move' && (item.event.duration ?? 0) > 0) {
        const task = dispatchEvent(state, item.event, options.keyMethod || 'scan-code', execution)
          .catch((error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            failures.push(failure);
            moveFailure.abort(failure);
          });
        moveTasks.push(task);
      } else {
        await dispatchEvent(state, item.event, options.keyMethod || 'scan-code', execution);
      }
    }
    await Promise.all(moveTasks);
    if (failures.length) throw failures[0];
    execution.assertActive();
    finalProbe = await probeNative(state, execution);
    execution.assertActive();
    completed = true;
  } finally {
    await Promise.allSettled(moveTasks);
    if (!options.preserveHeld || !completed) {
      const current = getHeldInputState(state);
      released = await releaseHeldInputsNative(
        state,
        addedValues(current.buttons, initialButtons),
        addedValues(current.keys.keys(), initialKeys)
      );
    }
  }
  if (!finalProbe) throw new Error('Timeline did not complete');
  return {
    ok: true,
    cursor: { x: finalProbe.x, y: finalProbe.y },
    windowHandle: finalProbe.windowHandle,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    eventCount: ordered.length,
    maximumLatenessMs: Math.round(maximumLatenessMs * 100) / 100,
    released
  };
}, queueOptions);
