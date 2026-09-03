import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ScreenElement } from '../types/perception';
import { openCvWorkerSource } from './opencvWorkerScript';
import { childEnvironment } from '../util/childEnvironment';

type WorkerResponse = { id: string; ok: boolean; elements?: ScreenElement[]; error?: string };
type Pending = {
  resolve: (elements: ScreenElement[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  worker: ChildProcessWithoutNullStreams;
  signal?: AbortSignal;
  abort?: () => void;
};
type CvResult = { elements: ScreenElement[]; warning?: string };
export type OpenCvAnalysisLevel = 'standard' | 'deep';

const require = createRequire(import.meta.url);
const pending = new Map<string, Pending>();
let child: ChildProcessWithoutNullStreams | undefined;
let analysisQueue: Promise<void> = Promise.resolve();
let lastFailureAt = 0;
let stopped = false;
const workers = new Set<ChildProcessWithoutNullStreams>();
const workerClosures = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
const intentionalStops = new WeakSet<ChildProcessWithoutNullStreams>();

const abortError = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('OpenCV analysis was cancelled.'), { name: 'AbortError' });

const clearPending = (entry: Pending) => {
  clearTimeout(entry.timer);
  if (entry.abort) entry.signal?.removeEventListener('abort', entry.abort);
};

const trackWorker = (worker: ChildProcessWithoutNullStreams) => {
  const closed = new Promise<void>((resolve) => {
    worker.once('close', () => {
      workers.delete(worker);
      resolve();
    });
  });
  workers.add(worker);
  workerClosures.set(worker, closed);
};

const stopWorker = async (worker: ChildProcessWithoutNullStreams, message: string) => {
  const closed = workerClosures.get(worker);
  if (!closed) return;
  const timer = setTimeout(() => {
    if (worker.exitCode === null) try { worker.kill(); } catch {}
  }, 2_000);
  timer.unref();
  intentionalStops.add(worker);
  try {
    try {
      if (worker.exitCode === null && worker.stdin.writable) worker.stdin.write(`${message}\n`);
    } catch {
      if (worker.exitCode === null) try { worker.kill(); } catch {}
    }
    await closed;
  } finally {
    clearTimeout(timer);
  }
};

const rejectPending = (message: string, worker: ChildProcessWithoutNullStreams) => {
  for (const [id, entry] of pending) {
    if (entry.worker !== worker) continue;
    clearPending(entry);
    entry.reject(new Error(message));
    pending.delete(id);
  }
};

const acceptResponse = (response: WorkerResponse) => {
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  clearPending(entry);
  response.ok ? entry.resolve(response.elements || []) : entry.reject(new Error(response.error || 'OpenCV analysis failed.'));
};

const startChild = () => {
  if (stopped) throw new Error('OpenCV worker is shut down.');
  if (child && !child.killed && child.exitCode === null) return child;
  if (Date.now() - lastFailureAt < 5_000) throw new Error('OpenCV worker is cooling down after a failure.');
  let output = '';
  let errors = '';
  const created = spawn(process.execPath, ['-e', openCvWorkerSource], {
    env: childEnvironment({
      COMPUTER_USE_OPENCV_MODULE: require.resolve('@techstark/opencv-js'),
      COMPUTER_USE_SHARP_MODULE: require.resolve('sharp')
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  trackWorker(created);
  child = created;
  created.stdout.on('data', (data: Buffer) => {
    output += data.toString('utf8');
    const lines = output.split(/\r?\n/);
    output = lines.pop() || '';
    for (const line of lines.filter(Boolean)) {
      try { acceptResponse(JSON.parse(line) as WorkerResponse); } catch { if (child === created) lastFailureAt = Date.now(); }
    }
  });
  created.stderr.on('data', (data: Buffer) => { errors = `${errors}${data.toString('utf8')}`.slice(-2000); });
  created.stdin.on('error', (error) => {
    if (created.killed || created.exitCode !== null) return;
    lastFailureAt = Date.now();
    if (child === created) child = undefined;
    rejectPending(error.message, created);
    created.kill();
  });
  created.once('error', (error) => {
    lastFailureAt = Date.now();
    if (child === created) child = undefined;
    rejectPending(error.message, created);
  });
  created.once('exit', (code) => {
    const intentional = intentionalStops.has(created);
    if (child === created) {
      child = undefined;
      lastFailureAt = code === 0 || intentional ? 0 : Date.now();
    } else if (code !== 0 && !intentional) lastFailureAt = Date.now();
    rejectPending(errors.trim() || `OpenCV worker exited with code ${code}.`, created);
  });
  return created;
};

const analyze = (
  bytes: Buffer,
  maxElements: number,
  analysisLevel: OpenCvAnalysisLevel,
  deadlineAt?: number,
  signal?: AbortSignal
) => new Promise<ScreenElement[]>((resolve, reject) => {
  try {
    if (signal?.aborted) throw abortError(signal);
    const limit = analysisLevel === 'deep' ? 45_000 : 20_000;
    const remaining = deadlineAt === undefined ? limit : Math.min(limit, deadlineAt - Date.now());
    if (remaining <= 0) throw new Error('OpenCV analysis deadline elapsed.');
    const active = startChild();
    const id = randomUUID();
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearPending(entry);
      if (child === active) {
        child = undefined;
        lastFailureAt = Date.now();
        active.kill();
      }
      reject(new Error('OpenCV analysis timed out.'));
    }, Math.max(1, remaining));
    const abort = signal ? () => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearPending(entry);
      if (child === active) child = undefined;
      lastFailureAt = 0;
      intentionalStops.add(active);
      if (active.exitCode === null) active.kill();
      reject(abortError(signal));
    } : undefined;
    pending.set(id, { resolve, reject, timer, worker: active, signal, abort });
    signal?.addEventListener('abort', abort!, { once: true });
    if (signal?.aborted) {
      abort?.();
      return;
    }
    try {
      active.stdin.write(`${JSON.stringify({ id, op: 'analyze', maxElements, analysisLevel, image: bytes.toString('base64') })}\n`);
    } catch (error) {
      const entry = pending.get(id);
      if (entry) clearPending(entry);
      pending.delete(id);
      throw error;
    }
  } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)));
  }
});

const runAnalysis = async (
  bytes: Buffer,
  maxElements: number,
  analysisLevel: OpenCvAnalysisLevel,
  deadlineAt?: number,
  signal?: AbortSignal
): Promise<CvResult> => {
  try {
    return { elements: await analyze(bytes, Math.max(1, Math.min(2_000, maxElements)), analysisLevel, deadlineAt, signal) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 400);
    return { elements: [], warning: `OpenCV unavailable: ${detail}` };
  }
};

export const detectVisualElements = (
  bytes: Buffer,
  maxElements: number,
  deadlineAt?: number,
  analysisLevel: OpenCvAnalysisLevel = 'standard',
  signal?: AbortSignal
) => {
  if (stopped) return Promise.resolve({ elements: [], warning: 'OpenCV unavailable: OpenCV worker is shut down.' });
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (deadlineAt !== undefined && deadlineAt <= Date.now()) return Promise.resolve({
    elements: [],
    warning: 'OpenCV unavailable: OpenCV analysis deadline elapsed.'
  });
  return new Promise<CvResult>((resolve, reject) => {
    let started = false;
    let settled = false;
    const finish = (result: CvResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => {
      if (settled || started || !signal) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(abortError(signal));
    };
    const timer = deadlineAt === undefined ? undefined : setTimeout(() => {
      if (started) return;
      finish({ elements: [], warning: 'OpenCV unavailable: OpenCV analysis deadline elapsed in queue.' });
    }, Math.max(1, deadlineAt - Date.now()));
    timer?.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const job = analysisQueue.catch(() => undefined).then(async () => {
      if (settled) return;
      started = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        finish(await runAnalysis(bytes, maxElements, analysisLevel, deadlineAt, signal));
      } catch (error) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    analysisQueue = job.then(() => undefined, () => undefined);
  });
};

export const terminateOpenCv = async () => {
  stopped = true;
  child = undefined;
  for (const worker of workers) rejectPending('OpenCV worker is shutting down.', worker);
  const active = [...workers];
  await Promise.all(active.map(async (worker) => await stopWorker(worker, JSON.stringify({ id: randomUUID(), op: 'close' }))));
  await analysisQueue.catch(() => undefined);
};
