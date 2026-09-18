import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { childEnvironment } from '../util/childEnvironment';
import { winApiSource } from './nativeSource';

type Response = { id: string; ok: boolean; output?: string; error?: string };
type Worker = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  receive?: (response: Response) => void;
  fail?: (error: Error) => void;
};
type Lane = { queue: Promise<void>; worker?: Worker };
const lanes = new Map<string, Lane>();
const workers = new Set<Worker>();
let stopped = false;

export const psLiteral = (value: string) => value.replace(/'/g, "''");

const workerScript = `
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -MemberDefinition '${psLiteral(winApiSource)}' -Name WindowApi -Namespace ComputerUse
[ComputerUse.WindowApi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
while(($requestLine=[Console]::In.ReadLine()) -ne $null){
try {
$request=$requestLine | ConvertFrom-Json
$script=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.script))
$output=(& ([ScriptBlock]::Create($script)) | Out-String -Width 32768).Trim()
$response=@{id=[string]$request.id;ok=$true;output=$output}
} catch {
$response=@{id=[string]$request.id;ok=$false;error=$_.Exception.Message}
}
[Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 4 -Compress))
[Console]::Out.Flush()
}`;

const createWorker = (lane: Lane): Worker => {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-MTA', '-EncodedCommand',
    Buffer.from(workerScript, 'utf16le').toString('base64')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnvironment()
  });
  let close: () => void = () => undefined;
  const worker: Worker = { child, closed: new Promise<void>((resolve) => { close = resolve; }) };
  workers.add(worker);
  lane.worker = worker;
  let errors = '';
  const fail = (error: Error) => {
    if (lane.worker === worker) lane.worker = undefined;
    worker.fail?.(error);
    if (child.exitCode === null && !child.killed) child.kill();
  };
  const input = readline.createInterface({ input: child.stdout });
  input.on('line', (line) => {
    try { worker.receive?.(JSON.parse(line) as Response); }
    catch { fail(new Error('Invalid Windows query worker response.')); }
  });
  child.stderr.on('data', (data: Buffer) => { errors = (errors + data.toString('utf8')).slice(-2000); });
  child.stdin.on('error', fail);
  child.once('error', fail);
  child.once('close', () => {
    input.close();
    workers.delete(worker);
    fail(new Error(errors || 'Windows query worker closed.'));
    close();
  });
  return worker;
};

export const runPowerShell = (script: string, timeout = 12_000, signal?: AbortSignal, laneName = 'desktop'): Promise<string> => {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows desktop access requires Windows.'));
  if (stopped) return Promise.reject(new Error('Windows query workers are shut down.'));
  const lane = lanes.get(laneName) || { queue: Promise.resolve() };
  lanes.set(laneName, lane);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stopping = false;
    let active: Worker | undefined;
    let release: () => void = () => undefined;
    const finish = (error?: Error, output = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (active) { active.receive = undefined; active.fail = undefined; }
      release();
      error ? reject(error) : resolve(output);
    };
    const stop = (error: Error) => {
      if (settled || stopping) return;
      stopping = true;
      if (!active) { finish(error); return; }
      const worker = active;
      active = undefined;
      worker.receive = undefined;
      worker.fail = undefined;
      if (lane.worker === worker) lane.worker = undefined;
      if (worker.child.exitCode === null && !worker.child.killed) worker.child.kill();
      void worker.closed.then(() => finish(error));
    };
    const abort = () => stop(Object.assign(new Error('PowerShell desktop operation was cancelled.'), { name: 'AbortError' }));
    const timer = setTimeout(() => stop(new Error(`PowerShell desktop operation timed out after ${timeout}ms.`)), Math.max(1, timeout));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    lane.queue = lane.queue.catch(() => undefined).then(async () => {
      if (settled) return;
      if (stopped) { finish(new Error('Windows query workers are shut down.')); return; }
      await new Promise<void>((done) => {
        release = done;
        try {
          active = lane.worker || createWorker(lane);
          const id = randomUUID();
          active.fail = stop;
          active.receive = (response) => {
            if (response.id !== id) { stop(new Error('Windows query response identity mismatch.')); return; }
            finish(response.ok ? undefined : new Error(response.error || 'Windows desktop operation failed.'), response.output || '');
          };
          active.child.stdin.write(`${JSON.stringify({ id, script: Buffer.from(script, 'utf8').toString('base64') })}\n`);
        } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
      });
    });
  });
};

export const runPowerShellJson = async <T>(script: string, fallback: T, timeout = 12_000, signal?: AbortSignal, lane = 'desktop'): Promise<T> => {
  const output = await runPowerShell(script, timeout, signal, lane);
  return output ? JSON.parse(output) as T : fallback;
};

export const terminatePowerShell = async () => {
  stopped = true;
  const active = [...workers];
  for (const worker of active) {
    worker.fail?.(new Error('Windows query workers are shutting down.'));
    if (worker.child.exitCode === null && !worker.child.killed) worker.child.kill();
  }
  await Promise.all(active.map((worker) => worker.closed));
  await Promise.all([...lanes.values()].map((lane) => lane.queue));
  lanes.clear();
};

export const normalizePowerShellArray = <T>(value: T | T[] | null | undefined): T[] =>
  Array.isArray(value) ? value : value ? [value] : [];