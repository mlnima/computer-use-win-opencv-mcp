import { execFile } from 'node:child_process';

const executable = 'powershell.exe';

export const psLiteral = (value: string) => value.replaceAll("'", "''");

const abortReason = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('PowerShell request was cancelled.'), { name: 'AbortError' });

export const runPowerShell = async (script: string, timeout = 15_000, signal?: AbortSignal): Promise<string> =>
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    execFile(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, signal },
      (error, stdout, stderr) => error
        ? reject(signal?.aborted ? abortReason(signal) : new Error(stderr.trim() || error.message))
        : resolve(stdout.trim())
    );
  });

export const runPowerShellJson = async <T>(script: string, timeout = 15_000, signal?: AbortSignal): Promise<T> => {
  const output = await runPowerShell(`${script} | ConvertTo-Json -Depth 12 -Compress`, timeout, signal);
  return output ? JSON.parse(output) as T : [] as T;
};
