import os from 'node:os';
import * as pty from '@lydell/node-pty';
import type { RuntimeState, TerminalSession } from '../types/runtime';
import { newId } from '../runtime/state';
import { childEnvironment } from '../util/childEnvironment';

const assertActive = (signal?: AbortSignal) => signal?.throwIfAborted();

export const createTerminal = (state: RuntimeState, shell?: string, cwd?: string, columns = 120, rows = 30, signal?: AbortSignal) => {
  assertActive(signal);
  if (state.terminals.size >= state.config.maxTerminalSessions) throw new Error('Terminal session limit reached.');
  const id = newId('terminal');
  const process = pty.spawn(shell || 'powershell.exe', [], {
    name: 'xterm-256color',
    cols: columns,
    rows,
    cwd: cwd || os.homedir(),
    env: childEnvironment({ TERM: 'xterm-256color' }) as Record<string, string>
  });
  const session: TerminalSession = { id, pty: process, output: '', baseOffset: 0, cursor: 0, createdAt: Date.now(), lastUsedAt: Date.now() };
  process.onData((data) => {
    const combined = session.output + data;
    const removed = Math.max(0, combined.length - 2_000_000);
    session.output = combined.slice(removed);
    session.baseOffset += removed;
    session.lastUsedAt = Date.now();
  });
  process.onExit(() => state.terminals.delete(id));
  state.terminals.set(id, session);
  return { id, processId: process.pid, columns, rows };
};

const getTerminal = (state: RuntimeState, id: string, signal?: AbortSignal) => {
  assertActive(signal);
  const session = state.terminals.get(id);
  if (!session) throw new Error(`Terminal session not found: ${id}`);
  session.lastUsedAt = Date.now();
  return session;
};

export const writeTerminal = (state: RuntimeState, id: string, data: string, signal?: AbortSignal) => {
  const session = getTerminal(state, id, signal);
  session.pty.write(data);
  return { id, written: data.length };
};

export const readTerminal = (state: RuntimeState, id: string, from?: number, maxChars = 32_768, signal?: AbortSignal) => {
  const session = getTerminal(state, id, signal);
  const available = session.baseOffset + session.output.length;
  const start = Math.max(session.baseOffset, Math.min(from ?? session.cursor, available));
  const data = session.output.slice(start - session.baseOffset, start - session.baseOffset + Math.max(1, Math.min(262_144, maxChars)));
  session.cursor = start + data.length;
  return { id, data, from: start, cursor: session.cursor, oldest: session.baseOffset, available };
};

export const resizeTerminal = (state: RuntimeState, id: string, columns: number, rows: number, signal?: AbortSignal) => {
  getTerminal(state, id, signal).pty.resize(columns, rows);
  return { id, columns, rows };
};

export const closeTerminal = (state: RuntimeState, id: string, signal?: AbortSignal) => {
  getTerminal(state, id, signal).pty.kill();
  state.terminals.delete(id);
  return { id, closed: true };
};
