import type { RuntimeState } from '../types/runtime';
import { clearHeldInputState, getHeldInputState } from './heldState';
import { buttonNative, keyNative, releaseAllNative } from './nativeActions';

export type ReleaseResult = {
  buttons: number;
  keys: number;
};

const releaseTrackedInputs = async (
  state: RuntimeState,
  onlyButtons?: Set<string>,
  onlyKeys?: Set<string>
): Promise<ReleaseResult & { failures: string[] }> => {
  const held = getHeldInputState(state);
  let buttons = 0;
  let keys = 0;
  const failures: string[] = [];
  for (const button of [...held.buttons]) {
    if (onlyButtons && !onlyButtons.has(button)) continue;
    try {
      await buttonNative(state, button, false);
      held.buttons.delete(button);
      buttons += 1;
    } catch (error) {
      failures.push(`mouse ${button}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [identity, value] of [...held.keys].reverse()) {
    if (onlyKeys && !onlyKeys.has(identity)) continue;
    try {
      await keyNative(state, {
        id: identity,
        virtualKey: value.key || undefined,
        scanCode: value.scan || undefined,
        extended: value.extended
      }, false, value.method);
      held.keys.delete(identity);
      keys += 1;
    } catch (error) {
      failures.push(`key ${identity}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { buttons, keys, failures };
};

export const releaseHeldInputsNative = async (
  state: RuntimeState,
  onlyButtons?: Set<string>,
  onlyKeys?: Set<string>
): Promise<ReleaseResult> => {
  const held = getHeldInputState(state);
  const first = await releaseTrackedInputs(state, onlyButtons, onlyKeys);
  let buttons = first.buttons;
  let keys = first.keys;
  let failures = first.failures;
  if (failures.length) {
    const retry = await releaseTrackedInputs(state, onlyButtons, onlyKeys);
    buttons += retry.buttons;
    keys += retry.keys;
    failures = retry.failures;
  }
  if (!onlyButtons && !onlyKeys && state.inputWorker) {
    try {
      const released = await releaseAllNative(state);
      buttons += released.buttons;
      keys += released.keys;
    } catch (error) {
      failures.push(`worker release-all: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!held.buttons.size && !held.keys.size) clearHeldInputState(state);
  if (state.drag && !held.buttons.has(state.drag.button)) state.drag = undefined;
  if (failures.length) throw new Error(`Native input release failed: ${failures.join('; ')}`);
  return { buttons, keys };
};
