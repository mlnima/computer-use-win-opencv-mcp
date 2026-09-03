import type { Bounds, MonitorInfo, WindowInfo } from '../types/geometry';
import { listMonitors } from '../windows/monitors';
import { getWindow } from '../windows/windows';
import { validBounds } from '../windows/values';
import { captureGdi } from './gdiCapture';
import { captureDxgi, captureWgc, nativeMonitorIndex } from './nativeCapture';

export type CaptureTarget = {
  windowHandle?: string;
  window?: WindowInfo;
  bounds?: Bounds;
  includeCursor?: boolean;
  signal?: AbortSignal;
};

export type CaptureResult = {
  bytes: Buffer;
  width: number;
  height: number;
  bounds: Bounds;
  windowHandle?: string;
  backend: string;
};

const contains = (outer: Bounds, inner: Bounds) =>
  inner.left >= outer.left && inner.top >= outer.top
  && inner.right <= outer.right && inner.bottom <= outer.bottom;

const sameBounds = (first: Bounds, second: Bounds) =>
  first.left === second.left && first.top === second.top
  && first.right === second.right && first.bottom === second.bottom;

const union = (items: Bounds[]): Bounds => ({
  left: Math.min(...items.map((entry) => entry.left)),
  top: Math.min(...items.map((entry) => entry.top)),
  right: Math.max(...items.map((entry) => entry.right)),
  bottom: Math.max(...items.map((entry) => entry.bottom))
});

const matchingMonitor = (monitors: MonitorInfo[], bounds: Bounds) =>
  monitors.find((monitor) => contains(monitor, bounds));

const abortError = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Screen capture was cancelled.'), { name: 'AbortError' });

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

const captureMonitor = async (
  monitor: MonitorInfo,
  monitors: MonitorInfo[],
  requestedBounds: Bounds | undefined,
  includeCursor: boolean,
  signal?: AbortSignal
) => {
  const fallbackIndex = Math.max(1, monitors.indexOf(monitor) + 1);
  const monitorIndex = await nativeMonitorIndex(monitor.name, fallbackIndex);
  if (signal?.aborted) throw abortError(signal);
  const options = { monitorIndex, sourceBounds: monitor, requestedBounds, signal };
  if (includeCursor) return await captureWgc({ ...options, includeCursor });
  return await captureDxgi(options).catch(async () => await captureWgc({ ...options, includeCursor }));
};

const validateBounds = (bounds: Bounds) => {
  if (!validBounds(bounds)) throw new Error('Capture bounds must be a finite, non-empty rectangle.');
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width > 32_768 || height > 32_768 || width * height > 150_000_000) {
    throw new Error('Capture bounds exceed the supported image size.');
  }
};

export const captureTarget = async (target: CaptureTarget = {}): Promise<CaptureResult> => {
  if (process.platform !== 'win32') throw new Error('Desktop capture requires Windows.');
  if (target.signal?.aborted) throw abortError(target.signal);
  const includeCursor = target.includeCursor === true;
  const monitors = await awaitSignal(listMonitors(target.signal), target.signal);
  if (monitors.length === 0) throw new Error('No active Windows displays were found.');
  if (target.windowHandle && !/^\d+$/.test(target.windowHandle)) {
    throw new Error(`Invalid window handle: ${target.windowHandle}`);
  }
  if (target.bounds) validateBounds(target.bounds);
  if (target.windowHandle) {
    const window = target.window?.handle === target.windowHandle
      ? target.window
      : await getWindow(target.windowHandle, target.signal);
    if (window?.minimized) throw new Error(`Window is minimized: ${target.windowHandle}`);
    const sourceBounds = window?.bounds || target.bounds;
    if (!sourceBounds) throw new Error(`Window not found: ${target.windowHandle}`);
    validateBounds(sourceBounds);
    const requestedBounds = target.bounds || sourceBounds;
    const monitor = matchingMonitor(monitors, requestedBounds);
    const options = {
      windowHandle: target.windowHandle,
      sourceBounds,
      requestedBounds: target.bounds,
      includeCursor,
      signal: target.signal
    };
    const assertCurrentWindow = async () => {
      const current = await getWindow(target.windowHandle!, target.signal);
      if (!current) throw new Error(`Window not found: ${target.windowHandle}`);
      if (current.minimized) throw new Error(`Window is minimized: ${target.windowHandle}`);
      if (!sameBounds(current.bounds, sourceBounds)) throw new Error(`Window moved or resized during capture: ${target.windowHandle}`);
    };
    const native = await captureWgc(options).catch(async () => {
      await assertCurrentWindow();
      return monitor && !includeCursor
        ? await captureMonitor(monitor, monitors, requestedBounds, false, target.signal)
          .catch(async () => await captureGdi(requestedBounds, includeCursor, target.signal))
        : await captureGdi(requestedBounds, includeCursor, target.signal);
    });
    await assertCurrentWindow();
    return { ...native, windowHandle: target.windowHandle };
  }
  const bounds = target.bounds || union(monitors);
  validateBounds(bounds);
  const monitor = matchingMonitor(monitors, bounds);
  const result = monitor
    ? await captureMonitor(monitor, monitors, target.bounds, includeCursor, target.signal)
      .catch(async () => await captureGdi(bounds, includeCursor, target.signal))
    : await captureGdi(bounds, includeCursor, target.signal);
  return result;
};
