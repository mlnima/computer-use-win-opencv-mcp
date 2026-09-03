import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ScreenElement } from '../types/perception';
import { boundsArea, clipBounds, safePointForBounds } from './geometry';
import { ocrWorkerSource } from './ocrWorkerScript';

type OcrBox = { x0: number; y0: number; x1: number; y1: number };
type OcrWord = { text?: string; confidence?: number; bbox?: OcrBox };
type OcrLine = { text?: string; confidence?: number; bbox?: OcrBox; words?: OcrWord[] };
type OcrParagraph = { lines?: OcrLine[] };
type OcrBlock = { paragraphs?: OcrParagraph[] };
type WorkerResponse = { id: string; ok: boolean; blocks?: OcrBlock[]; error?: string };
type Pending = { resolve: (blocks: OcrBlock[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type OcrResult = { elements: ScreenElement[]; warning?: string };

const require = createRequire(import.meta.url);
const pending = new Map<string, Pending>();
let child: ChildProcessWithoutNullStreams | undefined;
let stdoutBuffer = '';
let stderrBuffer = '';
let recognitionQueue: Promise<void> = Promise.resolve();
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

const rejectPending = (message: string) => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
  pending.clear();
};

const acceptResponse = (response: WorkerResponse) => {
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  clearTimeout(entry.timer);
  response.ok ? entry.resolve(response.blocks || []) : entry.reject(new Error(response.error || 'OCR failed.'));
};

const acceptOutput = (data: Buffer) => {
  stdoutBuffer += data.toString('utf8');
  const lines = stdoutBuffer.split(/\r?\n/);
  stdoutBuffer = lines.pop() || '';
  for (const line of lines.filter(Boolean)) {
    try { acceptResponse(JSON.parse(line) as WorkerResponse); } catch { lastFailureAt = Date.now(); }
  }
};

const startChild = (runtimeDir: string, langPath?: string) => {
  if (stopped) throw new Error('OCR worker is shut down.');
  if (child && !child.killed && child.exitCode === null) return child;
  if (Date.now() - lastFailureAt < 30_000) throw new Error('OCR worker is cooling down after a startup failure.');
  stdoutBuffer = '';
  stderrBuffer = '';
  const cachePath = path.join(runtimeDir, 'tesseract');
  fs.mkdirSync(cachePath, { recursive: true });
  const created = spawn(process.execPath, ['-e', ocrWorkerSource], {
    env: {
      ...process.env,
      COMPUTER_USE_TESSERACT_MODULE: require.resolve('tesseract.js'),
      COMPUTER_USE_TESSERACT_CACHE: cachePath,
      COMPUTER_USE_TESSERACT_LANG_PATH: langPath
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  trackWorker(created);
  child = created;
  created.stdout.on('data', acceptOutput);
  created.stderr.on('data', (data: Buffer) => { stderrBuffer = `${stderrBuffer}${data.toString('utf8')}`.slice(-2000); });
  created.stdin.on('error', (error) => {
    if (created.killed || created.exitCode !== null) return;
    lastFailureAt = Date.now();
    if (child === created) child = undefined;
    rejectPending(error.message);
    created.kill();
  });
  created.once('error', (error) => {
    lastFailureAt = Date.now();
    if (child === created) child = undefined;
    rejectPending(error.message);
  });
  created.once('exit', (code) => {
    lastFailureAt = code === 0 ? 0 : Date.now();
    if (child === created) child = undefined;
    rejectPending(stderrBuffer.trim() || `OCR worker exited with code ${code}.`);
  });
  return created;
};

const recognize = (bytes: Buffer, languages: string, timeoutMs: number, runtimeDir: string, langPath?: string) => new Promise<OcrBlock[]>((resolve, reject) => {
  try {
    const active = startChild(runtimeDir, langPath);
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      if (child === active) {
        child = undefined;
        lastFailureAt = Date.now();
        active.kill();
      }
      reject(new Error('OCR recognition timed out.'));
    }, Math.max(1, timeoutMs));
    pending.set(id, { resolve, reject, timer });
    active.stdin.write(`${JSON.stringify({ id, op: 'recognize', languages, image: bytes.toString('base64') })}\n`);
  } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)));
  }
});

const elementFromText = (
  text: string,
  confidence: number,
  box: OcrBox,
  width: number,
  height: number,
  id: string,
  role: string
): ScreenElement | undefined => {
  const bounds = clipBounds({ left: box.x0, top: box.y0, right: box.x1, bottom: box.y1 }, width, height);
  const safePoint = safePointForBounds(bounds);
  return text && confidence >= 20 && boundsArea(bounds) >= 4 && safePoint ? {
    id,
    role,
    name: text,
    bounds,
    safePoint,
    confidence: Math.max(0.25, Math.min(0.94, confidence / 100)),
    enabled: true,
    focused: false,
    offscreen: false,
    actions: ['click'],
    sources: ['ocr']
  } : undefined;
};

const extractElements = (blocks: OcrBlock[], width: number, height: number, maxElements: number) => {
  const elements: ScreenElement[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const words = (line.words || []).filter((word) => word.text?.trim() && word.bbox);
        const lineText = line.text?.replace(/\s+/g, ' ').trim() || words.map((word) => word.text?.trim()).join(' ');
        if (words.length > 1 && line.bbox && elements.length < maxElements) {
          const element = elementFromText(lineText, line.confidence || 0, line.bbox, width, height, `ocr:line:${elements.length}`, 'textLine');
          if (element) elements.push(element);
        }
        for (const word of words) {
          if (elements.length >= maxElements) return elements;
          const element = elementFromText(word.text?.trim() || '', word.confidence || 0, word.bbox!, width, height, `ocr:word:${elements.length}`, 'text');
          if (element) elements.push(element);
        }
      }
    }
  }
  return elements;
};

const runRecognition = async (
  bytes: Buffer,
  languages: string,
  width: number,
  height: number,
  maxElements: number,
  runtimeDir: string,
  langPath?: string,
  deadlineAt?: number
): Promise<OcrResult> => {
  try {
    const remaining = deadlineAt === undefined ? 60_000 : Math.min(60_000, deadlineAt - Date.now());
    if (remaining <= 0) throw new Error('OCR recognition deadline elapsed.');
    const blocks = await recognize(bytes, languages.split(/[+,]/).map((value) => value.trim()).filter(Boolean).join('+') || 'eng', remaining, runtimeDir, langPath);
    return { elements: extractElements(blocks, width, height, maxElements) };
  } catch (error) {
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
  deadlineAt?: number
) => {
  if (stopped) return Promise.resolve({ elements: [], warning: 'OCR unavailable: OCR worker is shut down.' });
  if (deadlineAt !== undefined && deadlineAt <= Date.now()) return Promise.resolve({
    elements: [],
    warning: 'OCR unavailable: OCR recognition deadline elapsed.'
  });
  return new Promise<OcrResult>((resolve) => {
    let started = false;
    let expired = false;
    const timer = deadlineAt === undefined ? undefined : setTimeout(() => {
      if (started) return;
      expired = true;
      resolve({ elements: [], warning: 'OCR unavailable: OCR recognition deadline elapsed in queue.' });
    }, Math.max(1, deadlineAt - Date.now()));
    timer?.unref();
    const job = recognitionQueue.catch(() => undefined).then(async () => {
      if (expired) return;
      started = true;
      if (timer) clearTimeout(timer);
      resolve(await runRecognition(bytes, languages, width, height, maxElements, runtimeDir, langPath, deadlineAt));
    });
    recognitionQueue = job.then(() => undefined, () => undefined);
  });
};

export const terminateOcr = async () => {
  stopped = true;
  child = undefined;
  rejectPending('OCR worker is shutting down.');
  const active = [...workers];
  await Promise.all(active.map(async (worker) => await stopWorker(worker, JSON.stringify({ id: randomUUID(), op: 'close' }))));
  await recognitionQueue.catch(() => undefined);
};
