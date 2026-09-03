import { performance } from 'node:perf_hooks';
import type { InputExecution } from './execution';
import { waitForInput } from './execution';

export const delay = (milliseconds: number) => new Promise<void>((resolve) => {
  if (milliseconds <= 0) resolve();
  else setTimeout(resolve, milliseconds);
});

export const waitUntil = async (target: number, execution?: InputExecution) => {
  let remaining = target - performance.now();
  if (remaining > 3) execution ? await waitForInput(execution, remaining - 2) : await delay(remaining - 2);
  remaining = target - performance.now();
  while (remaining > 0) {
    execution?.assertActive();
    if (remaining > 0.8) await new Promise<void>((resolve) => setImmediate(resolve));
    remaining = target - performance.now();
  }
  execution?.assertActive();
};
