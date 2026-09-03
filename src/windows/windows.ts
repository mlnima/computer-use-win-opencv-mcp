import { setTimeout as sleep } from 'node:timers/promises';
import type { Bounds, Point, WindowInfo } from '../types/geometry';
import { winApiSource } from './nativeSource';
import { normalizePowerShellArray, psLiteral, runPowerShell, runPowerShellJson } from './powershell';
import { toWindow, validBounds } from './values';

type CaptureModule = {
  enumerateWindows?: () => unknown[];
  foregroundWindow?: () => unknown;
};

let captureModulePromise: Promise<CaptureModule | null> | undefined;
let nativeFailureUntil = 0;
let windowCache: { at: number; windows: WindowInfo[] } | undefined;
let windowRequest: Promise<WindowInfo[]> | undefined;

const abortError = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Window query was cancelled.'), { name: 'AbortError' });

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

const invalidateWindowCache = () => {
  windowCache = undefined;
};

const loadCaptureModule = async (): Promise<CaptureModule | null> => {
  captureModulePromise ||= import('@screen-capture/node')
    .then((value) => value as CaptureModule)
    .catch(() => null);
  return await captureModulePromise;
};

const listPowerShellWindows = async () => {
  const raw = await runPowerShellJson<Record<string, unknown> | Record<string, unknown>[]>(`
Add-Type -MemberDefinition '${psLiteral(winApiSource)}' -Name WindowApi -Namespace ComputerUse
[ComputerUse.WindowApi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$foreground=[ComputerUse.WindowApi]::GetForegroundWindow()
$processes=@{};Get-Process | ForEach-Object {$processes[$_.Id]=$_.ProcessName}
$handles=[System.Collections.Generic.List[System.IntPtr]]::new()
$callback=[ComputerUse.WindowApi+EnumWindowsProc]{param([IntPtr]$handle,[IntPtr]$state)
if([ComputerUse.WindowApi]::IsWindowVisible($handle) -and [ComputerUse.WindowApi]::GetWindowTextLength($handle) -gt 0){$handles.Add($handle)}
return $true}
[ComputerUse.WindowApi]::EnumWindows($callback,[IntPtr]::Zero) | Out-Null
$handles | ForEach-Object {
$handle=$_;$rect=New-Object ComputerUse.WindowApi+RECT
[ComputerUse.WindowApi]::GetVisualWindowRect($handle,[ref]$rect) | Out-Null
$processId=[uint32]0;[ComputerUse.WindowApi]::GetWindowThreadProcessId($handle,[ref]$processId) | Out-Null
$length=[ComputerUse.WindowApi]::GetWindowTextLength($handle);$title=[System.Text.StringBuilder]::new($length+1)
[ComputerUse.WindowApi]::GetWindowText($handle,$title,$title.Capacity) | Out-Null
[PSCustomObject]@{
handle=$handle.ToInt64().ToString();title=$title.ToString();processId=[int]$processId;processName=[string]$processes[[int]$processId]
minimized=[ComputerUse.WindowApi]::IsIconic($handle);visible=$true
foreground=($handle -eq $foreground);bounds=[PSCustomObject]@{left=$rect.Left;top=$rect.Top;right=$rect.Right;bottom=$rect.Bottom}
}
} | ConvertTo-Json -Depth 5 -Compress`, []);
  return normalizePowerShellArray(raw).map(toWindow);
};

const listNativeWindows = async (): Promise<WindowInfo[]> => {
  if (Date.now() < nativeFailureUntil) return [];
  const native = await loadCaptureModule();
  if (!native?.enumerateWindows) return [];
  try {
    const foreground = native.foregroundWindow?.() as Record<string, unknown> | undefined;
    const foregroundHandle = String(foreground?.handle || '');
    return native.enumerateWindows().map((value) => {
      const entry = value as Record<string, unknown>;
      return toWindow({
        ...entry,
        bounds: entry.rect,
        minimized: Number(entry.width || 0) <= 0 || Number(entry.height || 0) <= 0,
        visible: entry.isValid !== false,
        foreground: String(entry.handle || '') === foregroundHandle
      });
    });
  } catch {
    nativeFailureUntil = Date.now() + 30_000;
    return [];
  }
};

const enumerateWindows = async (): Promise<WindowInfo[]> => {
  const shell = await listPowerShellWindows().catch(() => []);
  const windows = shell.length > 0 ? shell : await listNativeWindows();
  return windows
    .filter((entry) => entry.handle && entry.title && validBounds(entry.bounds))
    .sort((a, b) => Number(b.foreground) - Number(a.foreground) || a.title.localeCompare(b.title));
};

export const listWindows = async (signal?: AbortSignal, refresh = false): Promise<WindowInfo[]> => {
  if (signal?.aborted) throw abortError(signal);
  if (!refresh && windowCache && Date.now() - windowCache.at < 3_000) return windowCache.windows;
  windowRequest ||= enumerateWindows().then((windows) => {
    windowCache = { at: Date.now(), windows };
    return windows;
  }).finally(() => {
    windowRequest = undefined;
  });
  return await awaitSignal(windowRequest, signal);
};

export const getWindow = async (handle: string, signal?: AbortSignal): Promise<WindowInfo | null> => {
  if (!/^\d+$/.test(handle)) throw new Error(`Invalid window handle: ${handle}`);
  const raw = await runPowerShellJson<Record<string, unknown> | null>(`
Add-Type -MemberDefinition '${psLiteral(winApiSource)}' -Name WindowApi -Namespace ComputerUse
[ComputerUse.WindowApi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$handle=[IntPtr]([Int64]'${handle}')
if(-not [ComputerUse.WindowApi]::IsWindow($handle)){return}
$rect=New-Object ComputerUse.WindowApi+RECT
if(-not [ComputerUse.WindowApi]::GetVisualWindowRect($handle,[ref]$rect)){return}
$processId=[uint32]0;[ComputerUse.WindowApi]::GetWindowThreadProcessId($handle,[ref]$processId) | Out-Null
$length=[ComputerUse.WindowApi]::GetWindowTextLength($handle);$title=New-Object System.Text.StringBuilder ($length+1)
[ComputerUse.WindowApi]::GetWindowText($handle,$title,$title.Capacity) | Out-Null
$processName='';try{$processName=(Get-Process -Id $processId).ProcessName}catch{}
[PSCustomObject]@{
handle=$handle.ToInt64().ToString();title=$title.ToString();processId=[int]$processId;processName=$processName
minimized=[ComputerUse.WindowApi]::IsIconic($handle);visible=[ComputerUse.WindowApi]::IsWindowVisible($handle);foreground=($handle -eq [ComputerUse.WindowApi]::GetForegroundWindow())
bounds=[PSCustomObject]@{left=$rect.Left;top=$rect.Top;right=$rect.Right;bottom=$rect.Bottom}
} | ConvertTo-Json -Depth 4 -Compress`, null, 12_000, signal);
  return raw ? toWindow(raw) : null;
};

export const foregroundWindow = async (signal?: AbortSignal): Promise<WindowInfo | null> =>
  (await listWindows(signal, true)).find((entry) => entry.foreground) || null;

export const getCursor = async (signal?: AbortSignal): Promise<Point> =>
  await runPowerShellJson<Point>(`
Add-Type -MemberDefinition '${psLiteral(winApiSource)}' -Name WindowApi -Namespace ComputerUse
[ComputerUse.WindowApi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$point=New-Object ComputerUse.WindowApi+POINT
if(-not [ComputerUse.WindowApi]::GetCursorPos([ref]$point)){throw 'GetCursorPos failed.'}
[PSCustomObject]@{x=[int]$point.X;y=[int]$point.Y} | ConvertTo-Json -Compress`, { x: 0, y: 0 }, 12_000, signal);

export const foregroundHandle = async (signal?: AbortSignal) =>
  await runPowerShell(`
Add-Type -MemberDefinition '${psLiteral(winApiSource)}' -Name WindowApi -Namespace ComputerUse
[ComputerUse.WindowApi]::GetForegroundWindow().ToInt64().ToString()`, 12_000, signal);

export const focusWindow = async (handle: string, signal?: AbortSignal): Promise<void> => {
  if (!/^\d+$/.test(handle)) throw new Error(`Invalid window handle: ${handle}`);
  await runPowerShell(`
Add-Type -MemberDefinition '${psLiteral(winApiSource)}' -Name WindowApi -Namespace ComputerUse
$target=[IntPtr]([Int64]'${handle}')
$foreground=[ComputerUse.WindowApi]::GetForegroundWindow()
$targetPid=[uint32]0;$foregroundPid=[uint32]0
$targetThread=[ComputerUse.WindowApi]::GetWindowThreadProcessId($target,[ref]$targetPid)
$foregroundThread=[ComputerUse.WindowApi]::GetWindowThreadProcessId($foreground,[ref]$foregroundPid)
$currentThread=[ComputerUse.WindowApi]::GetCurrentThreadId()
$attachedCurrent=$false;$attachedForeground=$false
try {
if($targetThread -eq 0){throw 'Window not found.'}
if($currentThread -ne $targetThread){$attachedCurrent=[ComputerUse.WindowApi]::AttachThreadInput($currentThread,$targetThread,$true)}
if($foregroundThread -ne 0 -and $foregroundThread -ne $targetThread){$attachedForeground=[ComputerUse.WindowApi]::AttachThreadInput($foregroundThread,$targetThread,$true)}
[ComputerUse.WindowApi]::PulseAlt()
[ComputerUse.WindowApi]::ShowWindowAsync($target,9) | Out-Null
[ComputerUse.WindowApi]::BringWindowToTop($target) | Out-Null
[ComputerUse.WindowApi]::SetActiveWindow($target) | Out-Null
[ComputerUse.WindowApi]::SetFocus($target) | Out-Null
[ComputerUse.WindowApi]::SetForegroundWindow($target) | Out-Null
} finally {
if($attachedForeground){[ComputerUse.WindowApi]::AttachThreadInput($foregroundThread,$targetThread,$false) | Out-Null}
if($attachedCurrent){[ComputerUse.WindowApi]::AttachThreadInput($currentThread,$targetThread,$false) | Out-Null}
}`, 12_000, signal);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await foregroundHandle(signal) === handle) {
      invalidateWindowCache();
      return;
    }
    await sleep(75, undefined, signal ? { signal } : undefined);
  }
  throw new Error(`Windows did not foreground window ${handle}.`);
};

export type WindowControlAction = 'focus' | 'restore' | 'minimize' | 'maximize' | 'move' | 'resize' | 'close';

const validHandle = (handle: string) => /^\d+$/.test(handle);

const validateControlBounds = (bounds?: Bounds) => {
  if (!bounds || !validBounds(bounds)) throw new Error('This window action requires finite, non-empty bounds.');
  return {
    left: Math.round(bounds.left),
    top: Math.round(bounds.top),
    width: Math.round(bounds.right - bounds.left),
    height: Math.round(bounds.bottom - bounds.top)
  };
};

export const controlWindow = async (handle: string, action: WindowControlAction, bounds?: Bounds, signal?: AbortSignal): Promise<void> => {
  if (!validHandle(handle)) throw new Error(`Invalid window handle: ${handle}`);
  if (action === 'focus') return await focusWindow(handle, signal);
  const requested = action === 'move' || action === 'resize' ? validateControlBounds(bounds) : undefined;
  await runPowerShell(`
Add-Type -MemberDefinition '${psLiteral(winApiSource)}' -Name WindowApi -Namespace ComputerUse
$handle=[IntPtr]([Int64]'${handle}')
if(-not [ComputerUse.WindowApi]::IsWindow($handle)){throw 'Window not found.'}
$action='${action}'
if($action -eq 'restore'){[ComputerUse.WindowApi]::ShowWindowAsync($handle,9) | Out-Null}
if($action -eq 'minimize'){[ComputerUse.WindowApi]::ShowWindowAsync($handle,6) | Out-Null}
if($action -eq 'maximize'){[ComputerUse.WindowApi]::ShowWindowAsync($handle,3) | Out-Null}
if($action -eq 'close'){[ComputerUse.WindowApi]::PostMessage($handle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null}
if($action -eq 'move' -or $action -eq 'resize'){
$rect=New-Object ComputerUse.WindowApi+RECT
if(-not [ComputerUse.WindowApi]::GetWindowRect($handle,[ref]$rect)){throw 'Window bounds are unavailable.'}
$x=$(if($action -eq 'move'){${requested?.left || 0}}else{$rect.Left})
$y=$(if($action -eq 'move'){${requested?.top || 0}}else{$rect.Top})
$width=$(if($action -eq 'resize'){${requested?.width || 1}}else{$rect.Right-$rect.Left})
$height=$(if($action -eq 'resize'){${requested?.height || 1}}else{$rect.Bottom-$rect.Top})
if(-not [ComputerUse.WindowApi]::MoveWindow($handle,$x,$y,$width,$height,$true)){throw 'Window move or resize failed.'}
}`, 12_000, signal);
  invalidateWindowCache();
};

export const windowFromPoint = async (point: Point, signal?: AbortSignal): Promise<WindowInfo | null> => {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Point coordinates must be finite.');
  const raw = await runPowerShellJson<Record<string, unknown> | null>(`
Add-Type -MemberDefinition '${psLiteral(winApiSource)}' -Name WindowApi -Namespace ComputerUse
[ComputerUse.WindowApi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$point=New-Object ComputerUse.WindowApi+POINT;$point.X=${Math.round(point.x)};$point.Y=${Math.round(point.y)}
$handle=[ComputerUse.WindowApi]::WindowFromPoint($point)
if($handle -eq [IntPtr]::Zero){return}
$root=[ComputerUse.WindowApi]::GetAncestor($handle,2);if($root -ne [IntPtr]::Zero){$handle=$root}
$rect=New-Object ComputerUse.WindowApi+RECT;[ComputerUse.WindowApi]::GetVisualWindowRect($handle,[ref]$rect) | Out-Null
$processId=[uint32]0;[ComputerUse.WindowApi]::GetWindowThreadProcessId($handle,[ref]$processId) | Out-Null
$length=[ComputerUse.WindowApi]::GetWindowTextLength($handle);$title=New-Object System.Text.StringBuilder ($length+1)
[ComputerUse.WindowApi]::GetWindowText($handle,$title,$title.Capacity) | Out-Null
$processName='';try{$processName=(Get-Process -Id $processId).ProcessName}catch{}
[PSCustomObject]@{
handle=$handle.ToInt64().ToString();title=$title.ToString();processId=[int]$processId;processName=$processName
minimized=[ComputerUse.WindowApi]::IsIconic($handle);visible=[ComputerUse.WindowApi]::IsWindowVisible($handle);foreground=($handle -eq [ComputerUse.WindowApi]::GetForegroundWindow())
bounds=[PSCustomObject]@{left=$rect.Left;top=$rect.Top;right=$rect.Right;bottom=$rect.Bottom}
} | ConvertTo-Json -Depth 4 -Compress`, null, 12_000, signal);
  return raw ? toWindow(raw) : null;
};
