import type { RuntimeState } from '../types/runtime';
import type { MouseButton } from '../types/input';
import type { InputExecution } from './execution';
import type { KeyMethod, ResolvedKey } from './keyMap';
import type { NativeProbe } from './protocol';
import { getInputWorker, terminateInputWorker } from './worker';

const checked = async <T>(state: RuntimeState, execution: InputExecution | undefined, action: () => Promise<T>) => {
  execution?.assertActive();
  const operation = action();
  if (!execution) return await operation;
  const remaining = execution.remainingMs();
  if (remaining <= 0) execution.assertActive();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      execution.signal.removeEventListener('abort', abort);
      callback();
    };
    const stop = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      execution.signal.removeEventListener('abort', abort);
      void terminateInputWorker(state, error).then(() => reject(error), (failure) => reject(failure));
    };
    const abort = () => stop(execution.signal.reason instanceof Error ? execution.signal.reason : new Error('Input operation was cancelled'));
    const timer = Number.isFinite(remaining)
      ? setTimeout(() => stop(new Error('Native input operation exceeded its execution deadline')), Math.max(1, remaining))
      : undefined;
    execution.signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => finish(() => {
      try { execution.assertActive(); resolve(value); } catch (error) { reject(error); }
    }), (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
    if (execution.signal.aborted) abort();
  });
};

export const probeNative = (state: RuntimeState, execution?: InputExecution) =>
  checked(state, execution, () => getInputWorker(state).command<NativeProbe>({ op: 'probe' }));

export const moveAbsoluteNative = (state: RuntimeState, x: number, y: number, execution?: InputExecution) =>
  checked(state, execution, () => getInputWorker(state).command<void>({ op: 'moveAbsolute', x: Math.round(x), y: Math.round(y) }));

export const moveRelativeNative = (state: RuntimeState, x: number, y: number, execution?: InputExecution) =>
  checked(state, execution, () => getInputWorker(state).command<void>({ op: 'moveRelative', x: Math.round(x), y: Math.round(y) }));

export const buttonNative = (state: RuntimeState, button: MouseButton, down: boolean, execution?: InputExecution) =>
  checked(state, execution, () => getInputWorker(state).command<void>({ op: 'button', button, down }));

export const wheelNative = (state: RuntimeState, deltaX: number, deltaY: number, execution?: InputExecution) =>
  checked(state, execution, () => getInputWorker(state).command<void>({ op: 'wheel', deltaX: Math.round(deltaX), deltaY: Math.round(deltaY) }));

export const keyNative = (
  state: RuntimeState,
  key: ResolvedKey,
  down: boolean,
  method: KeyMethod,
  execution?: InputExecution
) => checked(state, execution, () => key.scanCode !== undefined
  ? getInputWorker(state).command<void>({ op: 'scanCode', scan: key.scanCode, down, extended: key.extended })
  : method === 'scan-code'
    ? getInputWorker(state).command<void>({
        op: 'mappedScanCode',
        key: key.virtualKey as number,
        down,
        extended: key.extended
      })
    : getInputWorker(state).command<void>({
        op: 'virtualKey',
        key: key.virtualKey as number,
        down,
        extended: key.extended
      }));

export const textNative = (state: RuntimeState, text: string, execution?: InputExecution) =>
  checked(state, execution, () => getInputWorker(state).command<void>({ op: 'text', text }, Math.max(15_000, text.length * 20)));

export const releaseAllNative = (state: RuntimeState) =>
  getInputWorker(state).command<{ buttons: number; keys: number }>({ op: 'releaseAll' });
