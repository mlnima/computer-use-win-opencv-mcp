import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeState } from '../types/runtime';
import { addResource, resourceReference } from '../runtime/resources';

const maxReadBytes = 25 * 1024 * 1024;
const readChunkBytes = 256 * 1024;

const assertActive = (signal?: AbortSignal) => signal?.throwIfAborted();

const readBounded = async (target: string, signal?: AbortSignal) => {
  assertActive(signal);
  const handle = await fs.open(target, 'r');
  try {
    assertActive(signal);
    const stats = await handle.stat();
    assertActive(signal);
    if (stats.size > maxReadBytes) throw new Error('File exceeds the 25 MB read limit.');
    const buffer = Buffer.alloc(Number(stats.size));
    let offset = 0;
    while (offset < buffer.length) {
      assertActive(signal);
      const length = Math.min(readChunkBytes, buffer.length - offset);
      const { bytesRead } = await handle.read(buffer, offset, length, offset);
      assertActive(signal);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    assertActive(signal);
    if ((await handle.read(probe, 0, 1, offset)).bytesRead) throw new Error('File exceeds the 25 MB read limit.');
    assertActive(signal);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
};

const decodeValue = (value: string, encoding: 'utf8' | 'base64') => {
  if (encoding === 'utf8') return Buffer.from(value, 'utf8');
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)) throw new Error('Value is not valid base64.');
  return Buffer.from(value, 'base64');
};

const fileInfo = async (target: string, signal?: AbortSignal) => {
  assertActive(signal);
  const stats = await fs.stat(target);
  assertActive(signal);
  return {
    path: path.resolve(target),
    name: path.basename(target),
    type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    createdAt: stats.birthtime.toISOString()
  };
};

export const listFiles = async (target: string, offset = 0, limit = 200, signal?: AbortSignal) => {
  assertActive(signal);
  const entries = await fs.readdir(target, { withFileTypes: true });
  assertActive(signal);
  const start = Math.max(0, offset);
  const selected = entries.slice(start, start + Math.max(1, Math.min(1000, limit)));
  return {
    path: path.resolve(target),
    offset: start,
    total: entries.length,
    entries: await Promise.all(selected.map((entry) => fileInfo(path.join(target, entry.name), signal)))
  };
};

export const readFileResource = async (state: RuntimeState, target: string, encoding: 'utf8' | 'base64', signal?: AbortSignal) => {
  const bytes = await readBounded(target, signal);
  const info = await fileInfo(target, signal);
  assertActive(signal);
  const resource = encoding === 'utf8'
    ? addResource(state, { name: path.basename(target), mimeType: 'text/plain', text: bytes.toString('utf8'), category: 'files' })
    : addResource(state, { name: path.basename(target), mimeType: 'application/octet-stream', bytes, category: 'files' });
  return { ...info, resource: resourceReference(resource) };
};

export const writeFileValue = async (target: string, value: string, encoding: 'utf8' | 'base64', append: boolean, signal?: AbortSignal) => {
  assertActive(signal);
  const bytes = decodeValue(value, encoding);
  assertActive(signal);
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  assertActive(signal);
  if (append) {
    const handle = await fs.open(target, 'a');
    try {
      assertActive(signal);
      await handle.appendFile(bytes, signal ? { signal } : undefined);
    } finally {
      await handle.close();
    }
  } else await fs.writeFile(target, bytes, signal ? { signal } : undefined);
  return await fileInfo(target);
};

export const manageFile = async (action: 'stat' | 'mkdir' | 'copy' | 'move' | 'delete', target: string, destination?: string, signal?: AbortSignal) => {
  if (action === 'stat') return await fileInfo(target, signal);
  if (action === 'mkdir') {
    assertActive(signal);
    await fs.mkdir(target, { recursive: true });
    return await fileInfo(target);
  }
  if (!destination && ['copy', 'move'].includes(action)) throw new Error('destination is required.');
  if (action === 'copy') {
    assertActive(signal);
    await fs.cp(target, destination!, { recursive: true, errorOnExist: true, force: false, filter: () => {
      assertActive(signal);
      return true;
    } });
  }
  if (action === 'move') {
    assertActive(signal);
    try { await fs.rename(target, destination!); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      assertActive(signal);
      await fs.cp(target, destination!, { recursive: true, errorOnExist: true, force: false, filter: () => {
        assertActive(signal);
        return true;
      } });
      assertActive(signal);
      await fs.rm(target, { recursive: true, force: false });
    }
  }
  if (action === 'delete') {
    assertActive(signal);
    await fs.rm(target, { recursive: true, force: false });
  }
  return { action, path: path.resolve(target), destination: destination ? path.resolve(destination) : undefined, ok: true };
};
