import type { RuntimeState } from '../types/runtime';

export const withInputLock = async <T>(state: RuntimeState, operation: () => Promise<T>): Promise<T> => {
  const previous = state.inputQueue.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.inputQueue = previous.then(() => current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};
