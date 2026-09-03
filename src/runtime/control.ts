import { releaseHeldInputs } from '../input/cleanup';
import type { RuntimeState } from '../types/runtime';
import { newId, recordTrace } from './state';

const clearPrepared = (state: RuntimeState, clientId?: string) => {
  for (const [id, prepared] of state.preparedPointers) {
    if (!clientId || prepared.clientId === clientId) state.preparedPointers.delete(id);
  }
};

const clearCleanupRetry = (state: RuntimeState) => {
  if (state.control.cleanupRetryTimer) clearTimeout(state.control.cleanupRetryTimer);
  state.control.cleanupRetryTimer = undefined;
};

const scheduleCleanupRetry = (state: RuntimeState, reason: string, clientId?: string) => {
  if (state.closing) return;
  clearCleanupRetry(state);
  const count = (state.control.cleanupRetryCount || 0) + 1;
  state.control.cleanupRetryCount = count;
  const delay = Math.min(30_000, 250 * 2 ** Math.min(7, count - 1));
  state.control.cleanupRetryTimer = setTimeout(() => {
    state.control.cleanupRetryTimer = undefined;
    void beginCleanup(state, `Retrying failed cleanup: ${reason}`, clientId).catch(() => undefined);
  }, delay);
  state.control.cleanupRetryTimer.unref();
};

const beginCleanup = (state: RuntimeState, reason: string, clientId?: string) => {
  clearCleanupRetry(state);
  const generation = (state.control.cleanupGeneration || 0) + 1;
  state.control.cleanupGeneration = generation;
  state.control.epoch += 1;
  recordTrace(state, 'control.cancel', { reason, clientId, epoch: state.control.epoch });
  clearPrepared(state, clientId);
  const cleanup = releaseHeldInputs(state, { bypassControl: true })
    .then(() => {
      if (state.control.cleanupGeneration !== generation) return;
      clearCleanupRetry(state);
      state.control.cleanupError = undefined;
      state.control.cleanupRetryCount = 0;
    })
    .catch((error: unknown) => {
      if (state.control.cleanupGeneration !== generation) throw error;
      state.control.cleanupError = error instanceof Error ? error.message : String(error);
      recordTrace(state, 'control.cleanupFailed', { reason, clientId, error: state.control.cleanupError });
      scheduleCleanupRetry(state, reason, clientId);
      throw error;
    })
    .finally(() => {
      if (state.control.cleanupGeneration === generation && state.control.cleanup === cleanup) state.control.cleanup = undefined;
    });
  state.control.cleanup = cleanup;
  return cleanup;
};

const clearLeaseTimer = (state: RuntimeState) => {
  if (state.control.leaseTimer) clearTimeout(state.control.leaseTimer);
  state.control.leaseTimer = undefined;
};

const scheduleLeaseExpiry = (state: RuntimeState, leaseId: string) => {
  clearLeaseTimer(state);
  const lease = state.control.lease;
  if (!lease || lease.id !== leaseId) return;
  state.control.leaseTimer = setTimeout(() => {
    const current = state.control.lease;
    if (!current || current.id !== leaseId) return;
    state.control.lease = undefined;
    clearLeaseTimer(state);
    void beginCleanup(state, 'Input lease expired', current.clientId).catch(() => undefined);
  }, Math.max(1, Date.parse(lease.expiresAt) - Date.now()));
  state.control.leaseTimer.unref();
};

const expireLease = (state: RuntimeState) => {
  const lease = state.control.lease;
  if (!lease || Date.parse(lease.expiresAt) > Date.now()) return undefined;
  state.control.lease = undefined;
  clearLeaseTimer(state);
  return beginCleanup(state, 'Input lease expired', lease.clientId);
};

const settleTransitions = async (state: RuntimeState) => {
  const expired = expireLease(state);
  if (expired) await expired;
  else if (state.control.cleanup) await state.control.cleanup;
  if (state.control.cleanupError) await beginCleanup(state, 'Retrying failed input cleanup');
};

const ownedLease = async (state: RuntimeState, clientId: string, leaseId?: string) => {
  await settleTransitions(state);
  const lease = state.control.lease;
  if (!lease) throw new Error('Acquire an input lease before changing the computer.');
  if (lease.clientId !== clientId || lease.id !== leaseId) throw new Error('The active input lease belongs to another client or the lease ID is invalid.');
  return lease;
};

export const assertControl = async (state: RuntimeState, clientId: string, leaseId?: string) => {
  await settleTransitions(state);
  if (state.control.emergencyStopped) throw new Error('Computer control is emergency-stopped. Explicitly resume before input.');
  if (state.control.paused) throw new Error('Computer control is paused.');
  return await ownedLease(state, clientId, leaseId);
};

export const acquireLease = async (state: RuntimeState, clientId: string, owner?: string, ttlMs = 30_000, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  await settleTransitions(state);
  signal?.throwIfAborted();
  if (state.control.lease) throw new Error('Computer input lease is already held.');
  const lease = {
    id: newId('lease'),
    owner,
    clientId,
    expiresAt: new Date(Date.now() + Math.max(1000, Math.min(300_000, ttlMs))).toISOString()
  };
  let committed = false;
  const cancel = () => {
    if (!committed || state.control.lease?.id !== lease.id) return;
    state.control.lease = undefined;
    clearLeaseTimer(state);
    void beginCleanup(state, 'Cancelled lease acquisition', clientId).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  signal?.throwIfAborted();
  state.control.lease = lease;
  committed = true;
  scheduleLeaseExpiry(state, lease.id);
  signal?.throwIfAborted();
  return { id: lease.id, owner: lease.owner, expiresAt: lease.expiresAt };
};

export const renewLease = async (state: RuntimeState, clientId: string, leaseId: string, ttlMs = 30_000, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const lease = await ownedLease(state, clientId, leaseId);
  signal?.throwIfAborted();
  const previousExpiry = lease.expiresAt;
  const expiresAt = new Date(Date.now() + Math.max(1000, Math.min(300_000, ttlMs))).toISOString();
  const cancel = () => {
    if (state.control.lease?.id !== lease.id || lease.expiresAt !== expiresAt) return;
    lease.expiresAt = previousExpiry;
    scheduleLeaseExpiry(state, lease.id);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  signal?.throwIfAborted();
  lease.expiresAt = expiresAt;
  scheduleLeaseExpiry(state, lease.id);
  signal?.throwIfAborted();
  return { id: lease.id, owner: lease.owner, expiresAt: lease.expiresAt };
};

export const releaseLease = async (state: RuntimeState, clientId: string, leaseId: string) => {
  const lease = await ownedLease(state, clientId, leaseId);
  state.control.lease = undefined;
  clearLeaseTimer(state);
  await beginCleanup(state, 'Input lease released', clientId);
  return { released: lease.id };
};

export const releaseClientControl = async (state: RuntimeState, clientId: string) => {
  clearPrepared(state, clientId);
  const lease = state.control.lease;
  if (!lease || lease.clientId !== clientId) return { released: false };
  state.control.lease = undefined;
  clearLeaseTimer(state);
  await beginCleanup(state, 'Input client disconnected', clientId);
  return { released: true };
};

export const cancelControlInput = async (
  state: RuntimeState,
  reason: string,
  options: { clearLease?: boolean } = {}
) => {
  const clientId = options.clearLease ? state.control.lease?.clientId : undefined;
  if (options.clearLease) {
    state.control.lease = undefined;
    clearLeaseTimer(state);
  }
  await beginCleanup(state, reason, clientId);
};

export const controlStatus = async (state: RuntimeState, clientId: string) => {
  await expireLease(state)?.catch(() => undefined);
  await state.control.cleanup?.catch(() => undefined);
  const lease = state.control.lease;
  return {
    paused: state.control.paused,
    emergencyStopped: state.control.emergencyStopped,
    epoch: state.control.epoch,
    cleanupError: state.control.cleanupError,
    lease: lease ? {
      owner: lease.owner,
      expiresAt: lease.expiresAt,
      ownedByClient: lease.clientId === clientId
    } : undefined
  };
};
