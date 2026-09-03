import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ScreenElement } from '../types/perception';
import { extractOcrElements, type OcrBlock } from './ocrElements';
import { ocrWorkerSource } from './ocrWorkerScript';
import { childEnvironment } from '../util/childEnvironment';

type WorkerResponse = { id: string; ok: boolean; blocks?: OcrBlock[]; error?: string };
type Pending = {
  resolve: (blocks: OcrBlock[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  worker: ChildProcessWithoutNullStreams;
  signal?: AbortSignal;
  abort?: () => void;
};
type OcrResult = { elements: ScreenElement[]; warning?: string };

const require = createRequire(import.meta.url);
const pending = new Map<string, Pending>();
let child: ChildProcessWithoutNullStreams | undefined;
let recognitionQueue: Promise<void> = Promise.resolve();
let lastFailureAt = 0;
let stopped = false;
const workers = new Set<ChildProcessWithoutNullStreams>();
const workerClosures = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
const intentionalStops = new WeakSet<ChildProcessWithoutNullStreams>();

const abortError = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('OCR recognition was cancelled.'), { name: 'AbortError' });

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
  response.ok ? entry.resolve(response.blocks || []) : entry.reject(new Error(response.error || 'OCR failed.'));
};

const startChild = (runtimeDir: string, langPath?: string) => {
  if (stopped) throw new Error('OCR worker is shut down.');
  if (child && !child.killed && child.exitCode === null) return child;
  if (Date.now() - lastFailureAt < 30_000) throw new Error('OCR worker is cooling down after a startup failure.');
  let output = '';
  let errors = '';
  const cachePath = path.join(runtimeDir, 'tesseract');
  fs.mkdirSync(cachePath, { recursive: true });
  const created = spawn(process.execPath, ['-e', ocrWorkerSource], {
    env: childEnvironment({
      COMPUTER_USE_TESSERACT_MODULE: require.resolve('tesseract.js'),
      COMPUTER_USE_TESSERACT_CACHE: cachePath,
      COMPUTER_USE_TESSERACT_LANG_PATH: langPath
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
    if (child === created) {
      lastFailureAt = code === 0 || intentionalStops.has(created) ? 0 : Date.now();
      child = undefined;
    }
    rejectPending(errors.trim() || `OCR worker exited with code ${code}.`, created);
  });
  return created;
};

const recognize = (bytes: Buffer, languages: string, timeoutMs: number, runtimeDir: string, langPath?: string, signal?: AbortSignal) => new Promise<OcrBlock[]>((resolve, reject) => {
  try {
    if (signal?.aborted) throw abortError(signal);
    const active = startChild(runtimeDir, langPath);
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
      reject(new Error('OCR recognition timed out.'));
    }, Math.max(1, timeoutMs));
    const abort = signal ? () => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearPending(entry);
      if (child === active) child = undefined;
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
      active.stdin.write(`${JSON.stringify({ id, op: 'recognize', languages, image: bytes.toString('base64') })}\n`);
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

const runRecognition = async (
  bytes: Buffer,
  languages: string,
  width: number,
  height: number,
  maxElements: number,
  runtimeDir: string,
  langPath?: string,
  deadlineAt?: number,
  signal?: AbortSignal
): Promise<OcrResult> => {
  try {
    const remaining = deadlineAt === undefined ? 60_000 : Math.min(60_000, deadlineAt - Date.now());
    if (remaining <= 0) throw new Error('OCR recognition deadline elapsed.');
    const blocks = await recognize(bytes, languages.split(/[+,]/).map((value) => value.trim()).filter(Boolean).join('+') || 'eng', remaining, runtimeDir, langPath, signal);
    return { elements: extractOcrElements(blocks, width, height, maxElements) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 400);
    return { elements: [], warning: `OCR unavailable: ${detail}` };
  }
};

export const detectTextElements = (
  bytes: Buffer,
  languages: string,
  width: number,
  height: number,
  maxElements: number,
  runtimeDir: string,
  langPath?: string,
  deadlineAt?: number,
  signal?: AbortSignal
) => {
  if (stopped) return Promise.resolve({ elements: [], warning: 'OCR unavailable: OCR worker is shut down.' });
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (deadlineAt !== undefined && deadlineAt <= Date.now()) return Promise.resolve({
    elements: [],
    warning: 'OCR unavailable: OCR recognition deadline elapsed.'
  });
  return new Promise<OcrResult>((resolve, reject) => {
    let started = false;
    let settled = false;
    const finish = (result: OcrResult) => {
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
      finish({ elements: [], warning: 'OCR unavailable: OCR recognition deadline elapsed in queue.' });
    }, Math.max(1, deadlineAt - Date.now()));
    timer?.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const job = recognitionQueue.catch(() => undefined).then(async () => {
      if (settled) return;
      started = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        finish(await runRecognition(bytes, languages, width, height, maxElements, runtimeDir, langPath, deadlineAt, signal));
      } catch (error) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    recognitionQueue = job.then(() => undefined, () => undefined);
  });
};

export const terminateOcr = async () => {
  stopped = true;
  child = undefined;
  for (const worker of workers) rejectPending('OCR worker is shutting down.', worker);
  const active = [...workers];
  await Promise.all(active.map(async (worker) => await stopWorker(worker, JSON.stringify({ id: randomUUID(), op: 'close' }))));
  await recognitionQueue.catch(() => undefined);
};
