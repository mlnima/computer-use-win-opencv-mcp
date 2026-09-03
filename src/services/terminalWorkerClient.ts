import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import type { RuntimeState } from '../types/runtime';
import { childEnvironment } from '../util/childEnvironment';
import type { TerminalCommandInput, TerminalListener, TerminalWorkerClient, TerminalWorkerMessage } from './terminalProtocol';

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const clients = new WeakMap<RuntimeState, TerminalWorkerClient>();
const workerPath = () => fileURLToPath(new URL('./terminalWorker.js', import.meta.url));

const createClient = (state: RuntimeState): TerminalWorkerClient => {
  if (process.platform !== 'win32') throw new Error('Terminal sessions are available only on Windows.');
  const child = spawn(process.execPath, [workerPath()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: childEnvironment()
  });
  state.terminalWorker = child;
  const pending = new Map<string, PendingRequest>();
  const listeners = new Map<string, TerminalListener>();
  const errors: string[] = [];
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let closed = false;
  let finalized = false;
  let exitResolve: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => { exitResolve = resolve; });
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startupTimeout = setTimeout(() => child.kill(), 10_000);
  const failPending = (error: Error) => {
    clearTimeout(startupTimeout);
    readyReject?.(error);
    readyReject = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  const finalize = (code: number | null) => {
    if (finalized) return;
    finalized = true;
    closed = true;
    clients.delete(state);
    if (state.terminalWorker === child) state.terminalWorker = undefined;
    const detail = errors.filter(Boolean).join(' ').slice(-1200);
    const error = new Error(`Terminal worker exited with code ${code}${detail ? `: ${detail}` : ''}`);
    failPending(error);
    for (const listener of listeners.values()) listener.exit(error);
    listeners.clear();
    exitResolve();
  };
  const output = readline.createInterface({ input: child.stdout });
  output.on('line', (line) => {
    let message: TerminalWorkerMessage;
    try { message = JSON.parse(line) as TerminalWorkerMessage; } catch { return; }
    if (message.type === 'ready') {
      clearTimeout(startupTimeout);
      readyResolve?.();
      readyResolve = undefined;
      readyReject = undefined;
      return;
    }
    if (message.type === 'data') return listeners.get(message.sessionId)?.data(message.data);
    if (message.type === 'exit') return listeners.get(message.sessionId)?.exit();
    if (message.type === 'fatal') {
      errors.push(message.error);
      child.kill();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.id);
    message.ok ? request.resolve(message.data) : request.reject(new Error(message.error));
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errors.push(chunk.trim());
    if (errors.length > 8) errors.shift();
  });
  child.stdin.on('error', (error) => { errors.push(error.message); });
  child.once('error', (error) => { errors.push(error.message); finalize(null); });
  child.once('exit', finalize);
  child.once('close', finalize);
  const command = async <T extends Record<string, unknown>>(value: TerminalCommandInput, timeoutMs = 10_000): Promise<T> => {
    await ready;
    if (closed || !child.stdin.writable) throw new Error('Terminal worker is closed.');
    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Terminal worker operation timed out after ${timeoutMs}ms.`));
        child.kill();
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: Record<string, unknown>) => void, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, ...value })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      });
    });
  };
  const attach = (sessionId: string, listener: TerminalListener) => {
    listeners.set(sessionId, listener);
    return () => listeners.delete(sessionId);
  };
  const close = async () => {
    if (closed) return await exited;
    await command({ action: 'shutdown' }, 3_000).catch(() => child.kill());
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 3_000);
    await exited;
    clearTimeout(timeout);
  };
  return { command, attach, close };
};

export const getTerminalWorker = (state: RuntimeState) => {
  const existing = clients.get(state);
  if (existing) return existing;
  const created = createClient(state);
  clients.set(state, created);
  return created;
};

export const closeTerminalWorker = async (state: RuntimeState) => {
  const client = clients.get(state);
  clients.delete(state);
  await client?.close();
  state.terminalWorker = undefined;
};
