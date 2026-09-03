import { performance } from 'node:perf_hooks';
import type { InputResult, KeyMode } from '../types/input';
import type { RuntimeState } from '../types/runtime';
import { waitForInput, type InputExecution } from './execution';
import { getHeldInputState } from './heldState';
import { resolveKey, type KeyMethod, type ResolvedKey } from './keyMap';
import { keyNative, probeNative, textNative } from './nativeActions';
import { enqueueInput } from './queue';
import { delay } from './timing';

export type KeyboardOptions = {
  keys: string | string[];
  mode?: KeyMode;
  method?: KeyMethod;
  holdMs?: number;
};

export type TextOptions = {
  text: string;
  intervalMs?: number;
};

const resultFromProbe = async (
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

const heldIdentity = (key: ResolvedKey, method: KeyMethod) => `${method}:${key.id}`;

const heldDescriptor = (key: ResolvedKey, method: KeyMethod) => ({
  key: key.virtualKey || 0,
  scan: key.scanCode || 0,
  extended: key.extended,
  method
});

export const keyboardKeyNative = async (
  state: RuntimeState,
  keyName: string,
  mode: KeyMode,
  method: KeyMethod = 'virtual-key',
  holdMs = 0,
  execution?: InputExecution
) => {
  execution?.assertActive();
  if (!Number.isFinite(holdMs) || holdMs < 0) throw new Error('Key hold must be a non-negative finite number');
  const key = resolveKey(keyName);
  const identity = heldIdentity(key, method);
  const held = getHeldInputState(state).keys;
  if (mode === 'press') {
    if (held.has(identity)) throw new Error(`Key ${keyName} is already held`);
    held.set(identity, heldDescriptor(key, method));
    await keyNative(state, key, true, method, execution);
    try {
      execution?.assertActive();
      if (holdMs > 0) execution
        ? await waitForInput(execution, Math.min(10_000, Math.round(holdMs)))
        : await delay(Math.min(10_000, Math.round(holdMs)));
    } finally {
      await keyNative(state, key, false, method);
      held.delete(identity);
    }
    return;
  }
  if (mode === 'down' && held.has(identity)) throw new Error(`Key ${keyName} is already held`);
  if (mode === 'down') held.set(identity, heldDescriptor(key, method));
  await keyNative(state, key, mode === 'down', method, execution);
  if (mode === 'up') {
    held.delete(identity);
    return;
  }
  try {
    execution?.assertActive();
  } catch (error) {
    const released = await keyNative(state, key, false, method).then(() => true, () => false);
    if (released) held.delete(identity);
    throw error;
  }
};

const releaseKeys = async (state: RuntimeState, names: string[], method: KeyMethod, execution?: InputExecution) => {
  const failures: string[] = [];
  for (const name of [...names].reverse()) {
    try { await keyboardKeyNative(state, name, 'up', method, 0, execution); }
    catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return failures;
};

const throwInputFailures = (operationError: unknown, releaseFailures: string[]) => {
  if (!operationError && !releaseFailures.length) return;
  const primary = operationError ? operationError instanceof Error ? operationError.message : String(operationError) : '';
  throw new Error([primary, releaseFailures.length ? `Key release failed: ${releaseFailures.join('; ')}` : ''].filter(Boolean).join('; '));
};

export const keyboardChordNative = async (
  state: RuntimeState,
  names: string[],
  mode: KeyMode,
  method: KeyMethod,
  holdMs: number,
  execution?: InputExecution
) => {
  if (mode === 'down') {
    const pressed: string[] = [];
    try {
      for (const name of names) {
        await keyboardKeyNative(state, name, 'down', method, 0, execution);
        pressed.push(name);
      }
    } catch (error) {
      throwInputFailures(error, await releaseKeys(state, pressed, method));
      return;
    }
    return;
  }
  if (mode === 'up') {
    throwInputFailures(undefined, await releaseKeys(state, names, method, execution));
    return;
  }
  const pressed: string[] = [];
  let operationError: unknown;
  try {
    for (const name of names) {
      await keyboardKeyNative(state, name, 'down', method, 0, execution);
      pressed.push(name);
    }
    if (holdMs > 0) execution ? await waitForInput(execution, holdMs) : await delay(holdMs);
  } catch (error) { operationError = error; }
  throwInputFailures(operationError, await releaseKeys(state, pressed, method));
};

export const keyboardInputNative = async (
  state: RuntimeState,
  options: KeyboardOptions,
  execution?: InputExecution
) => {
  const names = Array.isArray(options.keys) ? options.keys : [options.keys];
  if (!names.length || names.some((name) => !name)) throw new Error('Every requested key must be non-empty');
  if (options.holdMs !== undefined && (!Number.isFinite(options.holdMs) || options.holdMs < 0))
    throw new Error('Key hold must be a non-negative finite number');
  const mode = options.mode || 'press';
  const method = options.method || 'virtual-key';
  const holdMs = Math.max(0, Math.min(10_000, Math.round(options.holdMs || 0)));
  await keyboardChordNative(state, names, mode, method, holdMs, execution);
};

export const keyboardInput = (state: RuntimeState, options: KeyboardOptions) => enqueueInput(state, async (execution) => {
  const startedAt = performance.now();
  await keyboardInputNative(state, options, execution);
  return resultFromProbe(state, startedAt, execution);
});

export const sendKey = (
  state: RuntimeState,
  key: string,
  mode: KeyMode = 'press',
  method: KeyMethod = 'virtual-key'
) => keyboardInput(state, { keys: key, mode, method });

export const sendChord = (
  state: RuntimeState,
  keys: string[],
  method: KeyMethod = 'virtual-key',
  holdMs = 0
) => keyboardInput(state, { keys, method, holdMs });

export const typeUnicodeTextNative = async (
  state: RuntimeState,
  options: TextOptions,
  execution?: InputExecution
) => {
  if (!options.text.length) throw new Error('Text input cannot be empty');
  if (options.text.length > 100_000) throw new Error('Text input is limited to 100000 UTF-16 code units');
  if (options.intervalMs !== undefined && (!Number.isFinite(options.intervalMs) || options.intervalMs < 0))
    throw new Error('Text interval must be a non-negative finite number');
  const intervalMs = Math.max(0, Math.min(2_000, Math.round(options.intervalMs || 0)));
  if (!intervalMs) {
    for (let index = 0; index < options.text.length; index += 1024) {
      await textNative(state, options.text.slice(index, index + 1024), execution);
      execution?.assertActive();
    }
    return;
  }
  const characters = Array.from(options.text);
  for (let index = 0; index < characters.length; index += 1) {
    await textNative(state, characters[index], execution);
    if (index + 1 < characters.length)
      execution ? await waitForInput(execution, intervalMs) : await delay(intervalMs);
  }
};

export const typeUnicodeText = (state: RuntimeState, options: TextOptions) => enqueueInput(state, async (execution) => {
  const startedAt = performance.now();
  await typeUnicodeTextNative(state, options, execution);
  return resultFromProbe(state, startedAt, execution);
});
