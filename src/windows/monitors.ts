import type { MonitorInfo } from '../types/geometry';
import { winApiSource } from './nativeSource';
import { normalizePowerShellArray, psLiteral, runPowerShellJson } from './powershell';
import { toMonitor, validBounds } from './values';

let monitorCache: { at: number; monitors: MonitorInfo[] } | undefined;
let monitorRequest: Promise<MonitorInfo[]> | undefined;

const abortError = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Monitor query was cancelled.'), { name: 'AbortError' });

const awaitSignal = async <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return await operation;
  if (signal.aborted) throw abortError(signal);
  let rejectAbort: (error: Error) => void = () => undefined;
  const abort = () => rejectAbort(abortError(signal));
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
};

const enumerateMonitors = async (): Promise<MonitorInfo[]> => {
  const raw = await runPowerShellJson<Record<string, unknown> | Record<string, unknown>[]>(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -MemberDefinition '${psLiteral(winApiSource)}' -Name WindowApi -Namespace ComputerUse
[ComputerUse.WindowApi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
$center=New-Object ComputerUse.WindowApi+POINT
$center.X=[int]($_.Bounds.Left+($_.Bounds.Width/2));$center.Y=[int]($_.Bounds.Top+($_.Bounds.Height/2))
$monitor=[ComputerUse.WindowApi]::MonitorFromPoint($center,2)
$dpiX=[uint32]96;$dpiY=[uint32]96
try {[ComputerUse.WindowApi]::GetDpiForMonitor($monitor,0,[ref]$dpiX,[ref]$dpiY) | Out-Null} catch {}
[PSCustomObject]@{
id=$_.DeviceName;name=$_.DeviceName;primary=$_.Primary;scale=([double]$dpiX/96.0)
bounds=[PSCustomObject]@{left=$_.Bounds.Left;top=$_.Bounds.Top;right=$_.Bounds.Right;bottom=$_.Bounds.Bottom}
}
} | ConvertTo-Json -Depth 4 -Compress`, []);
  return normalizePowerShellArray(raw).map(toMonitor).filter((entry) => validBounds(entry));
};

export const listMonitors = async (signal?: AbortSignal): Promise<MonitorInfo[]> => {
  if (signal?.aborted) throw abortError(signal);
  if (monitorCache && Date.now() - monitorCache.at < 30_000) return monitorCache.monitors;
  monitorRequest ||= enumerateMonitors().then((monitors) => {
    monitorCache = { at: Date.now(), monitors };
    return monitors;
  }).finally(() => {
    monitorRequest = undefined;
  });
  return await awaitSignal(monitorRequest, signal);
};
