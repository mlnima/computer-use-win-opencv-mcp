import type { Bounds } from '../types/geometry';

type NativeCaptureModule = {
  ScreenCapture: new (options: Record<string, unknown>) => {
    start: () => Promise<void>;
    nextFrame: () => Promise<NativeFrame | undefined>;
    stop: () => Promise<void>;
  };
  DxgiDuplicationSession?: new (options: Record<string, unknown>) => {
    acquireNextFrame: (timeoutMs?: number) => NativeFrame | null;
    recreate: () => void;
  };
  ImageFormat: { Png: unknown };
  enumerateMonitors?: () => Array<Record<string, unknown>>;
  isSupported?: () => boolean;
};

type NativeFrame = {
  width: number;
  height: number;
  crop: (left: number, top: number, right: number, bottom: number) => NativeFrame;
  encode: (format: unknown) => Buffer | Uint8Array;
};

export type NativeCaptureResult = {
  bytes: Buffer;
  width: number;
  height: number;
  bounds: Bounds;
  backend: string;
};

let modulePromise: Promise<NativeCaptureModule | null> | undefined;

const loadModule = async () => {
  modulePromise ||= import('@screen-capture/node')
    .then((value) => value as unknown as NativeCaptureModule)
    .catch(() => null);
  return await modulePromise;
};

const abortError = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Native capture was cancelled.'), { name: 'AbortError' });

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal) => {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    if (signal?.aborted) throw abortError(signal);
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Native capture timed out after ${timeoutMs}ms.`)), timeoutMs);
        timer.unref();
      }),
      new Promise<T>((_, reject) => {
        if (!signal) return;
        abort = () => reject(abortError(signal));
        signal.addEventListener('abort', abort, { once: true });
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener('abort', abort);
  }
};

const intersect = (a: Bounds, b: Bounds): Bounds | null => {
  const result = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom)
  };
  return result.right > result.left && result.bottom > result.top ? result : null;
};

const cropFrame = (frame: NativeFrame, sourceBounds: Bounds, requested?: Bounds) => {
  const bounds = requested ? intersect(sourceBounds, requested) : sourceBounds;
  if (!bounds) throw new Error('Requested capture bounds do not overlap the native target.');
  const sourceWidth = Math.max(1, sourceBounds.right - sourceBounds.left);
  const sourceHeight = Math.max(1, sourceBounds.bottom - sourceBounds.top);
  const left = Math.max(0, Math.floor((bounds.left - sourceBounds.left) * frame.width / sourceWidth));
  const top = Math.max(0, Math.floor((bounds.top - sourceBounds.top) * frame.height / sourceHeight));
  const right = Math.min(frame.width, Math.max(left + 1, Math.ceil((bounds.right - sourceBounds.left) * frame.width / sourceWidth)));
  const bottom = Math.min(frame.height, Math.max(top + 1, Math.ceil((bounds.bottom - sourceBounds.top) * frame.height / sourceHeight)));
  const cropped = left === 0 && top === 0 && right === frame.width && bottom === frame.height
    ? frame
    : frame.crop(left, top, right, bottom);
  return { frame: cropped, bounds };
};

const encode = (module: NativeCaptureModule, frame: NativeFrame, bounds: Bounds, backend: string): NativeCaptureResult => ({
  bytes: Buffer.from(frame.encode(module.ImageFormat.Png)),
  width: frame.width,
  height: frame.height,
  bounds,
  backend
});

export const nativeMonitorIndex = async (deviceName: string, fallbackIndex: number) => {
  const module = await loadModule();
  if (!module?.enumerateMonitors) return fallbackIndex;
  try {
    const monitors = module.enumerateMonitors();
    const match = monitors.findIndex((entry) =>
      String(entry.deviceName || entry.name || '').toLowerCase() === deviceName.toLowerCase());
    return match >= 0 ? match + 1 : fallbackIndex;
  } catch {
    return fallbackIndex;
  }
};

export const captureWgc = async (options: {
  windowHandle?: string;
  monitorIndex?: number;
  sourceBounds: Bounds;
  requestedBounds?: Bounds;
  includeCursor: boolean;
  signal?: AbortSignal;
}): Promise<NativeCaptureResult> => {
  const module = await loadModule();
  if (!module || module.isSupported?.() === false) throw new Error('Windows Graphics Capture is unavailable.');
  const target = options.windowHandle
    ? { windowHandle: Number(options.windowHandle) }
    : { monitorIndex: options.monitorIndex || 1 };
  const capture = new module.ScreenCapture({
    ...target,
    colorFormat: 'bgra8',
    cursorCapture: options.includeCursor,
    drawBorder: false,
    includeSecondaryWindows: true,
    minimumUpdateIntervalMs: 0,
    dirtyRegions: false
  });
  try {
    await withTimeout(capture.start(), 5_000, options.signal);
    const frame = await withTimeout(capture.nextFrame(), 5_000, options.signal);
    if (!frame) throw new Error('Windows Graphics Capture target closed before a frame arrived.');
    if (options.windowHandle) {
      const expectedWidth = options.sourceBounds.right - options.sourceBounds.left;
      const expectedHeight = options.sourceBounds.bottom - options.sourceBounds.top;
      if (Math.abs(frame.width - expectedWidth) > 2 || Math.abs(frame.height - expectedHeight) > 2) {
        throw new Error(`WGC frame geometry ${frame.width}x${frame.height} does not match the physical window bounds ${expectedWidth}x${expectedHeight}.`);
      }
    }
    const result = cropFrame(frame, options.sourceBounds, options.requestedBounds);
    return encode(module, result.frame, result.bounds, options.windowHandle ? 'wgc-window' : 'wgc-monitor');
  } finally {
    await withTimeout(capture.stop(), 1_000).catch(() => undefined);
  }
};

export const captureDxgi = async (options: {
  monitorIndex: number;
  sourceBounds: Bounds;
  requestedBounds?: Bounds;
  signal?: AbortSignal;
}): Promise<NativeCaptureResult> => {
  if (options.signal?.aborted) throw abortError(options.signal);
  const module = await loadModule();
  if (!module?.DxgiDuplicationSession) throw new Error('DXGI Desktop Duplication is unavailable.');
  const session = new module.DxgiDuplicationSession({ monitorIndex: options.monitorIndex });
  let frame = session.acquireNextFrame(100);
  if (!frame) {
    session.recreate();
    frame = session.acquireNextFrame(250);
  }
  if (!frame) throw new Error('DXGI did not provide a desktop frame.');
  if (options.signal?.aborted) throw abortError(options.signal);
  const result = cropFrame(frame, options.sourceBounds, options.requestedBounds);
  return encode(module, result.frame, result.bounds, 'dxgi-desktop-duplication');
};
