import { AsyncLocalStorage } from 'node:async_hooks';

type PerceptionContext = { deadlineAt: number; signal: AbortSignal };

const perceptionDeadline = new AsyncLocalStorage<PerceptionContext>();
const deadlineError = () => Object.assign(new Error('Perception deadline elapsed.'), { name: 'AbortError' });

export const withPerceptionDeadline = <T>(deadlineAt: number, operation: () => Promise<T>, requestSignal?: AbortSignal) => {
  const controller = new AbortController();
  const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
  return perceptionDeadline.run({ deadlineAt, signal }, async () => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0 || signal.aborted) throw deadlineError();
    const timer = setTimeout(() => controller.abort(deadlineError()), remaining);
    let rejectAbort: (error: Error) => void = () => undefined;
    const abort = () => rejectAbort(signal.reason instanceof Error ? signal.reason : deadlineError());
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; signal.addEventListener('abort', abort, { once: true }); });
    if (signal.aborted) abort();
    try { return await Promise.race([operation(), aborted]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  });
};

export const currentPerceptionDeadline = () => perceptionDeadline.getStore()?.deadlineAt;
export const currentPerceptionSignal = () => perceptionDeadline.getStore()?.signal;

export const assertPerceptionDeadline = () => {
  const context = perceptionDeadline.getStore();
  if (context && (Date.now() >= context.deadlineAt || context.signal.aborted)) throw deadlineError();
};
