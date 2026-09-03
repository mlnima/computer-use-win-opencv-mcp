import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import type { RuntimeState } from '../types/runtime';
import type { NativeCommand, WorkerClient, WorkerResponse } from './protocol';
import { inputWorkerScript, nativeInputSourceBase64 } from './workerScript';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

const clients = new WeakMap<RuntimeState, WorkerClient>();

const powerShellPath = () => process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

const encodeScript = () => Buffer.from(inputWorkerScript, 'utf16le').toString('base64');

const createClient = (state: RuntimeState): WorkerClient => {
  if (process.platform !== 'win32') throw new Error('Native input is available only on Windows');
  const child = spawn(powerShellPath(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodeScript()
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, COMPUTER_USE_NATIVE_INPUT_SOURCE: nativeInputSourceBase64 }
  });
  state.inputWorker = child;
  const pending = new Map<string, PendingRequest>();
  const errors: string[] = [];
  let readyResolve: (() => void) | undefined;
  let readyReject: ((reason: Error) => void) | undefined;
  let closed = false;
  let terminationError: Error | undefined;
  let finalized = false;
  let exitResolve: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => { exitResolve = resolve; });
  const startupTimeout = setTimeout(() => {
    void terminate(new Error('Native input worker did not become ready within 15 seconds'));
  }, 15_000);
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const failAll = (error: Error) => {
    clearTimeout(startupTimeout);
    readyReject?.(error);
    readyReject = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  const terminate = async (error: Error) => {
    if (closed) return await exited;
    closed = true;
    terminationError = error;
    clients.delete(state);
    if (state.inputWorker === child) state.inputWorker = undefined;
    child.kill();
    await exited;
  };
  const stdout = readline.createInterface({ input: child.stdout });
  child.stdin.on('error', (error) => { void terminate(error); });
  stdout.on('line', (line) => {
    const trimmed = line.trim().replace(/^\uFEFF/, '');
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as WorkerResponse & { ready?: boolean };
      if (parsed.ready) {
        clearTimeout(startupTimeout);
        readyResolve?.();
        readyResolve = undefined;
        readyReject = undefined;
        return;
      }
      const request = pending.get(parsed.id);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(parsed.id);
      parsed.ok ? request.resolve(parsed.data) : request.reject(new Error(parsed.error || 'Native input failed'));
    } catch {
      errors.push(trimmed);
      if (errors.length > 8) errors.shift();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errors.push(chunk.trim());
    if (errors.length > 8) errors.shift();
  });
  child.once('error', (error) => { void terminate(error); });
  const finalize = (code: number | null) => {
    if (finalized) return;
    finalized = true;
    closed = true;
    if (state.inputWorker === child) {
      state.inputWorker = undefined;
      clients.delete(state);
    }
    const detail = errors.filter(Boolean).join(' ').slice(-1200);
    failAll(terminationError || new Error(`Native input worker exited with code ${code}${detail ? `: ${detail}` : ''}`));
    exitResolve();
  };
  child.once('exit', finalize);
  child.once('close', finalize);
  const command = async <T>(value: NativeCommand, timeoutMs = 15_000): Promise<T> => {
    await ready;
    if (closed || !child.stdin.writable) throw new Error('Native input worker is closed');
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void terminate(new Error(`Native input operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, ...value })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      });
    });
  };
  const close = async () => {
    if (closed) return await exited;
    await command({ op: 'close' }, 2_000).catch(() => undefined);
    child.stdin.end();
    const timeout = setTimeout(() => { child.kill(); }, 3_000);
    await exited;
    clearTimeout(timeout);
  };
  return { command, close, terminate };
};

export const getInputWorker = (state: RuntimeState): WorkerClient => {
  const existing = clients.get(state);
  if (existing) return existing;
  const created = createClient(state);
  clients.set(state, created);
  return created;
};

export const closeInputWorker = async (state: RuntimeState) => {
  const client = clients.get(state);
  clients.delete(state);
  await client?.close();
};

export const terminateInputWorker = async (state: RuntimeState, error: Error) => {
  const client = clients.get(state);
  if (client) await client.terminate(error);
  else state.inputWorker?.kill();
  clients.delete(state);
  state.inputWorker = undefined;
};
