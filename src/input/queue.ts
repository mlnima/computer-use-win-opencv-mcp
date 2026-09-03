import type { RuntimeState } from '../types/runtime';
import { performance } from 'node:perf_hooks';
import { createInputExecution, inputEpoch, type InputExecution } from './execution';
import { getHeldInputState } from './heldState';
import { releaseHeldInputsNative } from './releaseNative';

export type InputQueueOptions = {
  bypassControl?: boolean;
  deadlineMs?: number;
  owner?: { clientId: string; leaseId: string };
  signal?: AbortSignal;
};

export type InputTransaction = {
  guard: () => void;
  execution: InputExecution;
};

export const enqueueInput = <T>(
  state: RuntimeState,
  action: (execution: InputExecution) => Promise<T>,
  options: InputQueueOptions = {}
): Promise<T> => {
  if (options.deadlineMs !== undefined && (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0))
    return Promise.reject(new Error('Input deadline must be a positive finite duration'));
  if (options.signal?.aborted) return Promise.reject(new Error('MCP input request was cancelled.'));
  const epoch = inputEpoch(state);
  const next = state.inputQueue.catch(() => undefined).then(async () => {
    if (options.signal?.aborted) throw new Error('MCP input request was cancelled.');
    const lease = state.control.lease;
    if (options.owner && (!lease || lease.id !== options.owner.leaseId || lease.clientId !== options.owner.clientId || Date.parse(lease.expiresAt) <= Date.now())) {
      throw new Error('The input lease ended or changed while this operation was queued.');
    }
    const deadlineAt = options.deadlineMs === undefined ? undefined : performance.now() + options.deadlineMs;
    const execution = createInputExecution(state, epoch, { bypassControl: options.bypassControl, deadlineAt, signal: options.signal });
    execution.assertActive();
    return await action(execution);
  });
  state.inputQueue = next.then(() => undefined, () => undefined);
  return next;
};

export const runInputTransaction = <T>(
  state: RuntimeState,
  action: (transaction: InputTransaction) => Promise<T>,
  options: InputQueueOptions = {}
) => enqueueInput(state, async (execution) => {
  const held = getHeldInputState(state);
  const initialButtons = new Set<string>(held.buttons);
  const initialKeys = new Set(held.keys.keys());
  try {
    execution.assertActive();
    return await action({ guard: execution.assertActive, execution });
  } catch (error) {
    const current = getHeldInputState(state);
    const buttons = new Set([...current.buttons].filter((button) => !initialButtons.has(button)));
    const keys = new Set([...current.keys.keys()].filter((key) => !initialKeys.has(key)));
    await releaseHeldInputsNative(state, buttons, keys);
    throw error;
  }
}, options);
