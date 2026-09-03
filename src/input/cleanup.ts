import type { RuntimeState } from '../types/runtime';
import { cancelInputOperations } from './execution';
import { clearHeldInputState } from './heldState';
import { enqueueInput } from './queue';
import { releaseHeldInputsNative } from './releaseNative';
import { closeInputWorker } from './worker';

export { releaseHeldInputsNative } from './releaseNative';
export type { ReleaseResult } from './releaseNative';

export type ReleaseOptions = {
  bypassControl?: boolean;
  owner?: { clientId: string; leaseId: string };
  signal?: AbortSignal;
};

export const releaseHeldInputs = (state: RuntimeState, options: ReleaseOptions = {}) => {
  cancelInputOperations(state, 'Held input cleanup cancelled pending input');
  return enqueueInput(state, () => releaseHeldInputsNative(state), {
    bypassControl: options.bypassControl !== false,
    owner: options.owner,
    signal: options.signal
  });
};

export const shutdownInput = (state: RuntimeState) => {
  cancelInputOperations(state, 'Input runtime is shutting down');
  return enqueueInput(state, async () => {
    let releaseError: unknown;
    try {
      await releaseHeldInputsNative(state);
      clearHeldInputState(state);
      state.drag = undefined;
    } catch (error) {
      releaseError = error;
    } finally {
      await closeInputWorker(state);
    }
    if (releaseError) throw releaseError;
  }, { bypassControl: true });
};
