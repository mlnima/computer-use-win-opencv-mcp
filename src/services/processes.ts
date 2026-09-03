import { spawn } from 'node:child_process';
import { runPowerShell, runPowerShellJson, psLiteral } from '../util/powershell';

export type ProcessRecord = {
  id: number;
  name: string;
  path?: string;
  mainWindowTitle?: string;
  mainWindowHandle?: string;
};

type ProcessExit = { exitCode?: number | null; timedOut: boolean };
export type ProcessLaunch = { processId?: number; completion: Promise<ProcessExit> };

const abortReason = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Process request was cancelled.'), { name: 'AbortError' });

const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs: number, signal?: AbortSignal) =>
  new Promise<ProcessExit>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', exited);
      signal?.removeEventListener('abort', cancelled);
    };
    const exited = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, timedOut: false });
    };
    const failed = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.aborted ? abortReason(signal) : error);
    };
    const cancelled = () => {
      if (settled || !signal) return;
      settled = true;
      try { child.kill(); } catch {}
      child.unref();
      cleanup();
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child.unref();
      resolve({ exitCode: undefined, timedOut: true });
    }, Math.max(100, Math.min(300_000, timeoutMs)));
    timer.unref();
    child.once('exit', exited);
    child.once('error', failed);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });

export const listProcesses = async (query = '', limit = 500, signal?: AbortSignal): Promise<ProcessRecord[]> => {
  const data = await runPowerShellJson<ProcessRecord | ProcessRecord[]>(`Get-Process | Select-Object @{n='id';e={$_.Id}},@{n='name';e={$_.ProcessName}},@{n='path';e={$_.Path}},@{n='mainWindowTitle';e={$_.MainWindowTitle}},@{n='mainWindowHandle';e={$_.MainWindowHandle.ToInt64().ToString()}}`, 15_000, signal);
  const values = Array.isArray(data) ? data : data ? [data] : [];
  const normalized = query.toLocaleLowerCase();
  return values.filter((value) => !normalized || `${value.name} ${value.path || ''} ${value.mainWindowTitle || ''}`.toLocaleLowerCase().includes(normalized)).slice(0, Math.max(1, Math.min(2000, limit)));
};

export const startProcess = async (file: string, args: string[], cwd?: string, wait = false, timeoutMs = 30_000, startupSignal?: AbortSignal, completionSignal = startupSignal): Promise<ProcessLaunch> => {
  startupSignal?.throwIfAborted();
  const startup = new AbortController();
  const cancelStartup = () => startup.abort(startupSignal ? abortReason(startupSignal) : undefined);
  startupSignal?.addEventListener('abort', cancelStartup, { once: true });
  let child: ReturnType<typeof spawn>;
  try { child = spawn(file, args, { cwd, detached: !wait, stdio: 'ignore', windowsHide: false, signal: startup.signal }); }
  catch (error) { startupSignal?.removeEventListener('abort', cancelStartup); throw error; }
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off('spawn', spawned);
        child.off('error', failed);
      };
      const spawned = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(startupSignal?.aborted ? abortReason(startupSignal) : error); };
      child.once('spawn', spawned);
      child.once('error', failed);
    });
  } catch (error) {
    startupSignal?.removeEventListener('abort', cancelStartup);
    throw error;
  }
  startupSignal?.removeEventListener('abort', cancelStartup);
  if (startupSignal?.aborted) {
    try { child.kill(); } catch {}
    throw abortReason(startupSignal);
  }
  if (!wait) {
    child.unref();
    return { processId: child.pid, completion: Promise.resolve({ exitCode: undefined, timedOut: false }) };
  }
  const completion = child.exitCode !== null
    ? Promise.resolve({ exitCode: child.exitCode, timedOut: false })
    : waitForExit(child, timeoutMs, completionSignal);
  return { processId: child.pid, completion };
};

export const launchProcess = async (file: string, args: string[], cwd?: string, wait = false, timeoutMs = 30_000, signal?: AbortSignal) => {
  const launched = await startProcess(file, args, cwd, wait, timeoutMs, signal);
  return { processId: launched.processId, ...await launched.completion };
};

export const stopProcess = async (processId: number, force: boolean, signal?: AbortSignal) => {
  await runPowerShell(`Stop-Process -Id ${processId} -Force:$${force ? 'true' : 'false'} -ErrorAction Stop`, 15_000, signal);
  return { processId, stopped: true, force };
};

export const requestCloseProcess = async (processId: number, signal?: AbortSignal) => {
  const result = await runPowerShell(`$p=Get-Process -Id ${processId} -ErrorAction Stop; $p.CloseMainWindow()`, 15_000, signal);
  return { processId, closeRequested: result.toLowerCase() === 'true' };
};

export const shellOpen = async (target: string, signal?: AbortSignal) => {
  await runPowerShell(`Start-Process -FilePath '${psLiteral(target)}'`, 15_000, signal);
  return { opened: target };
};
