import type { RuntimeState } from '../types/runtime';
import type { MouseButton } from '../types/input';

export type HeldInputState = {
  buttons: Set<MouseButton>;
  keys: Map<string, { key: number; scan: number; extended: boolean; method: 'virtual-key' | 'scan-code' }>;
};

const heldInputs = new WeakMap<RuntimeState, HeldInputState>();

export const getHeldInputState = (state: RuntimeState): HeldInputState => {
  const existing = heldInputs.get(state);
  if (existing) return existing;
  const created: HeldInputState = { buttons: new Set(), keys: new Map() };
  heldInputs.set(state, created);
  return created;
};

export const clearHeldInputState = (state: RuntimeState) => heldInputs.delete(state);
