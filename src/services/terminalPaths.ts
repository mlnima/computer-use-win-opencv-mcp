import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnvironment } from '../util/childEnvironment';

const execFileAsync = promisify(execFile);

const requireFile = async (value: string, label: string) => {
  const metadata = await stat(value).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`${label} does not exist or is not a file: ${value}`);
  return value;
};

const requireDirectory = async (value: string) => {
  const resolved = path.resolve(value);
  const metadata = await stat(resolved).catch(() => undefined);
  if (!metadata?.isDirectory()) throw new Error(`Terminal working directory does not exist or is not a directory: ${resolved}`);
  return resolved;
};

const defaultShell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const locateShell = async (requested: string, cwd: string, signal?: AbortSignal) => {
  if (!requested.trim()) throw new Error('Terminal shell must not be empty.');
  if (path.isAbsolute(requested) || /[\\/]/.test(requested)) return await requireFile(path.resolve(cwd, requested), 'Terminal shell');
  try {
    const { stdout } = await execFileAsync('where.exe', [requested], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      signal,
      env: childEnvironment()
    });
    const candidate = String(stdout).split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (candidate) return await requireFile(candidate, 'Terminal shell');
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as { code?: string })?.code === 'ABORT_ERR') throw error;
  }
  throw new Error(`Terminal shell was not found: ${requested}`);
};

export const resolveTerminalPaths = async (shell?: string, cwd?: string, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const workingDirectory = await requireDirectory(cwd || os.homedir());
  signal?.throwIfAborted();
  const executable = await locateShell(shell || defaultShell(), workingDirectory, signal);
  signal?.throwIfAborted();
  return { shell: executable, cwd: workingDirectory };
};
