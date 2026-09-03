import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ScreenElement } from '../types/perception';
import { openCvWorkerSource } from './opencvWorkerScript';

type WorkerResponse = { id: string; ok: boolean; elements?: ScreenElement[]; error?: string };
type Pending = {
  resolve: (elements: ScreenElement[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  worker: ChildProcessWithoutNullStreams;
};
type CvResult = { elements: ScreenElement[]; warning?: string };

const require = createRequire(import.meta.url);
const pending = new Map<string, Pending>();
let child: ChildProcessWithoutNullStreams | undefined;
let analysisQueue: Promise<void> = Promise.resolve();
let lastFailureAt = 0;
let stopped = false;
const workers = new Set<ChildProcessWithoutNullStreams>();
const workerClosures = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

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
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
    pending.delete(id);
  }
};

const acceptResponse = (response: WorkerResponse) => {
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  clearTimeout(entry.timer);
  response.ok ? entry.resolve(response.elements || []) : entry.reject(new Error(response.error || 'OpenCV analysis failed.'));
};

const startChild = () => {
  if (stopped) throw new Error('OpenCV worker is shut down.');
  if (child && !child.killed && child.exitCode === null) return child;
  if (Date.now() - lastFailureAt < 5_000) throw new Error('OpenCV worker is cooling down after a failure.');
  let output = '';
  let errors = '';
  const created = spawn(process.execPath, ['-e', openCvWorkerSource], {
    env: {
      ...process.env,
      COMPUTER_USE_OPENCV_MODULE: require.resolve('@techstark/opencv-js'),
      COMPUTER_USE_SHARP_MODULE: require.resolve('sharp')
    },
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
      try { acceptResponse(JSON.parse(line) as WorkerResponse); } catch { lastFailureAt = Date.now(); }
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
    lastFailureAt = code === 0 ? 0 : Date.now();
    if (child === created) child = undefined;
    rejectPending(errors.trim() || `OpenCV worker exited with code ${code}.`, created);
  });
  return created;
};

const analyze = (bytes: Buffer, maxElements: number, deadlineAt?: number) => new Promise<ScreenElement[]>((resolve, reject) => {
  try {
    const remaining = deadlineAt === undefined ? 20_000 : Math.min(20_000, deadlineAt - Date.now());
    if (remaining <= 0) throw new Error('OpenCV analysis deadline elapsed.');
    const active = startChild();
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      if (child === active) {
        child = undefined;
        lastFailureAt = Date.now();
        active.kill();
      }
      reject(new Error('OpenCV analysis timed out.'));
    }, Math.max(1, remaining));
    pending.set(id, { resolve, reject, timer, worker: active });
    active.stdin.write(`${JSON.stringify({ id, op: 'analyze', maxElements, image: bytes.toString('base64') })}\n`);
  } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)));
  }
});

const runAnalysis = async (bytes: Buffer, maxElements: number, deadlineAt?: number): Promise<CvResult> => {
  try {
    return { elements: await analyze(bytes, Math.max(1, Math.min(2_000, maxElements)), deadlineAt) };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 400);
    return { elements: [], warning: `OpenCV unavailable: ${detail}` };
  }
};

export const detectVisualElements = (bytes: Buffer, maxElements: number, deadlineAt?: number) => {
  if (stopped) return Promise.resolve({ elements: [], warning: 'OpenCV unavailable: OpenCV worker is shut down.' });
  if (deadlineAt !== undefined && deadlineAt <= Date.now()) return Promise.resolve({
    elements: [],
    warning: 'OpenCV unavailable: OpenCV analysis deadline elapsed.'
  });
  return new Promise<CvResult>((resolve) => {
    let started = false;
    let expired = false;
    const timer = deadlineAt === undefined ? undefined : setTimeout(() => {
      if (started) return;
      expired = true;
      resolve({ elements: [], warning: 'OpenCV unavailable: OpenCV analysis deadline elapsed in queue.' });
    }, Math.max(1, deadlineAt - Date.now()));
    timer?.unref();
    const job = analysisQueue.catch(() => undefined).then(async () => {
      if (expired) return;
      started = true;
      if (timer) clearTimeout(timer);
      resolve(await runAnalysis(bytes, maxElements, deadlineAt));
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
