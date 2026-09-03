import { performance } from 'node:perf_hooks';
import type { RuntimeState } from '../types/runtime';

export type InputEpoch = {
  value: number;
  signal: AbortSignal;
};

export type InputExecution = InputEpoch & {
  deadlineAt?: number;
  bypassControl: boolean;
  assertActive: () => void;
  remainingMs: () => number;
};

type InputControl = {
  epoch: number;
  controller: AbortController;
};

const controls = new WeakMap<RuntimeState, InputControl>();
const stoppedError = (message: string) => Object.assign(new Error(message), { name: 'AbortError' });

const controlFor = (state: RuntimeState) => {
  const existing = controls.get(state);
  if (existing?.epoch === state.control.epoch) return existing;
  existing?.controller.abort(stoppedError('Input control epoch changed'));
  const created = { epoch: state.control.epoch, controller: new AbortController() };
  controls.set(state, created);
  return created;
};

export const inputEpoch = (state: RuntimeState): InputEpoch => {
  const control = controlFor(state);
  return { value: control.epoch, signal: control.controller.signal };
};

export const cancelInputOperations = (state: RuntimeState, reason = 'Input operation was cancelled') => {
  const control = controls.get(state);
  control?.controller.abort(stoppedError(reason));
  if (control?.epoch === state.control.epoch) state.control.epoch += 1;
  controls.set(state, { epoch: state.control.epoch, controller: new AbortController() });
  return state.control.epoch;
};

export const createInputExecution = (
  state: RuntimeState,
  epoch: InputEpoch,
  options: { bypassControl?: boolean; deadlineAt?: number; signal?: AbortSignal } = {}
): InputExecution => {
  const bypassControl = options.bypassControl === true;
  const signal = options.signal ? AbortSignal.any([epoch.signal, options.signal]) : epoch.signal;
  const assertActive = () => {
    if (signal.aborted || state.control.epoch !== epoch.value) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : stoppedError('Input operation was cancelled');
    }
    if (options.deadlineAt !== undefined && performance.now() >= options.deadlineAt)
      throw stoppedError('Input operation exceeded its execution deadline');
    if (!bypassControl && state.closing) throw stoppedError('Runtime is shutting down');
    if (!bypassControl && state.control.emergencyStopped) throw stoppedError('Computer control is emergency-stopped');
    if (!bypassControl && state.control.paused) throw stoppedError('Computer control is paused');
  };
  const remainingMs = () => options.deadlineAt === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, options.deadlineAt - performance.now());
  return { ...epoch, signal, deadlineAt: options.deadlineAt, bypassControl, assertActive, remainingMs };
};

export const withInputDeadline = (state: RuntimeState, execution: InputExecution, durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0)
    throw new Error('Input deadline must be a positive finite duration');
  const requested = performance.now() + Math.max(1, durationMs);
  const deadlineAt = execution.deadlineAt === undefined ? requested : Math.min(requested, execution.deadlineAt);
  return createInputExecution(state, execution, { bypassControl: execution.bypassControl, deadlineAt, signal: execution.signal });
};

export const waitForInput = async (execution: InputExecution, milliseconds: number) => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    throw new Error('Input wait must be a non-negative finite duration');
  execution.assertActive();
  const requested = Math.max(0, milliseconds);
  const endsAt = performance.now() + requested;
  while (performance.now() < endsAt) {
    execution.assertActive();
    const duration = Math.min(25, endsAt - performance.now(), execution.remainingMs());
    if (duration <= 0) {
      execution.assertActive();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        execution.signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        execution.signal.removeEventListener('abort', abort);
        reject(execution.signal.reason instanceof Error
          ? execution.signal.reason
          : stoppedError('Input operation was cancelled'));
      };
      const timer = setTimeout(finish, duration);
      execution.signal.addEventListener('abort', abort, { once: true });
      if (execution.signal.aborted) abort();
    });
  }
  execution.assertActive();
};
