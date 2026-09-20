import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeState } from '../types/runtime';

const receiptPaths = (state: RuntimeState, operationId: string) => {
  const directory = path.join(state.config.runtimeDir, 'operations');
  const id = createHash('sha256').update(operationId).digest('hex');
  return { directory, started: path.join(directory, `${id}.started.json`), completed: path.join(directory, `${id}.completed.json`) };
};

const readJson = async (file: string) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const durableWrite = async (file: string, value: unknown) => {
  const handle = await open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
};

export const readOperationReceipt = async (state: RuntimeState, operationId: string) => {
  const files = receiptPaths(state, operationId);
  const completed = await readJson(files.completed);
  if (completed) return { state: 'completed', result: completed.result as CallToolResult };
  const started = await readJson(files.started);
  return { state: started ? 'unknown' : 'not_found' };
};

export const acknowledgeOperationReceipt = async (state: RuntimeState, operationId: string) => {
  const files = receiptPaths(state, operationId);
  await unlink(files.completed).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return { acknowledged: true };
};

export const runReceiptedOperation = async (
  state: RuntimeState, operationId: string, name: string, args: unknown,
  operation: () => Promise<CallToolResult>,
): Promise<CallToolResult> => {
  const files = receiptPaths(state, operationId);
  const digest = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
  await mkdir(files.directory, { recursive: true });
  try { await durableWrite(files.started, { operationId, digest, startedAt: new Date().toISOString() }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const started = await readJson(files.started);
    if (started?.digest !== digest) throw new Error('Operation identifier was already used for different arguments.');
    const receipt = await readOperationReceipt(state, operationId);
    if (receipt.result) return receipt.result;
    return {
      isError: true,
      _meta: { 'io.eskai/outcome': 'unknown' },
      content: [{ type: 'text', text: 'This operation was already accepted and its outcome is not yet known. It has not been repeated. Observe the application and query computer_operation_status before another action.' }],
    };
  }
  const result = await operation();
  const temporary = `${files.completed}.${randomUUID()}.tmp`;
  try {
    await durableWrite(temporary, { result, completedAt: new Date().toISOString() });
    await rename(temporary, files.completed);
  } finally { await unlink(temporary).catch(() => undefined); }
  return result;
};
