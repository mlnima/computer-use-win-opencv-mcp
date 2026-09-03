import type { RuntimeState, TerminalSession } from '../types/runtime';
import { newId } from '../runtime/state';
import { resolveTerminalPaths } from './terminalPaths';
import { getTerminalWorker } from './terminalWorkerClient';

const assertActive = (signal?: AbortSignal) => signal?.throwIfAborted();

export const createTerminal = async (state: RuntimeState, shell?: string, cwd?: string, columns = 120, rows = 30, signal?: AbortSignal) => {
  assertActive(signal);
  if (state.terminals.size >= state.config.maxTerminalSessions) throw new Error('Terminal session limit reached.');
  const id = newId('terminal');
  const paths = await resolveTerminalPaths(shell, cwd, signal);
  const worker = getTerminalWorker(state);
  let detach: () => void = () => undefined;
  const session: TerminalSession = {
    id,
    processId: 0,
    output: '',
    baseOffset: 0,
    cursor: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    write: async (data) => { await worker.command({ action: 'write', sessionId: id, data }); },
    resize: async (nextColumns, nextRows) => { await worker.command({ action: 'resize', sessionId: id, columns: nextColumns, rows: nextRows }); },
    close: async () => {
      try { await worker.command({ action: 'close', sessionId: id }).then(() => undefined); }
      finally { detach(); state.terminals.delete(id); }
    }
  };
  detach = worker.attach(id, {
    data: (data) => {
      const combined = session.output + data;
      const removed = Math.max(0, combined.length - 2_000_000);
      session.output = combined.slice(removed);
      session.baseOffset += removed;
      session.lastUsedAt = Date.now();
    },
    exit: () => { detach(); state.terminals.delete(id); }
  });
  state.terminals.set(id, session);
  try {
    const created = await worker.command<{ processId: number }>({ action: 'create', sessionId: id, shell: paths.shell, cwd: paths.cwd, columns, rows });
    signal?.throwIfAborted();
    session.processId = created.processId;
    return { id, processId: created.processId, columns, rows };
  } catch (error) {
    detach();
    state.terminals.delete(id);
    await worker.command({ action: 'close', sessionId: id }, 2_000).catch(() => undefined);
    throw error;
  }
};

const getTerminal = (state: RuntimeState, id: string, signal?: AbortSignal) => {
  assertActive(signal);
  const session = state.terminals.get(id);
  if (!session) throw new Error(`Terminal session not found: ${id}`);
  session.lastUsedAt = Date.now();
  return session;
};

export const writeTerminal = async (state: RuntimeState, id: string, data: string, signal?: AbortSignal) => {
  const session = getTerminal(state, id, signal);
  await session.write(data);
  assertActive(signal);
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

export const resizeTerminal = async (state: RuntimeState, id: string, columns: number, rows: number, signal?: AbortSignal) => {
  await getTerminal(state, id, signal).resize(columns, rows);
  assertActive(signal);
  return { id, columns, rows };
};

export const closeTerminal = async (state: RuntimeState, id: string, signal?: AbortSignal) => {
  await getTerminal(state, id, signal).close();
  assertActive(signal);
  state.terminals.delete(id);
  return { id, closed: true };
};
