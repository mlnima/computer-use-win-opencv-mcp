import type { Bounds, MonitorInfo, WindowInfo } from '../types/geometry';

export const toBounds = (value: unknown): Bounds => {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    left: Math.round(Number(item.left ?? item.Left ?? 0)),
    top: Math.round(Number(item.top ?? item.Top ?? 0)),
    right: Math.round(Number(item.right ?? item.Right ?? 0)),
    bottom: Math.round(Number(item.bottom ?? item.Bottom ?? 0))
  };
};

export const toWindow = (value: Record<string, unknown>): WindowInfo => ({
  handle: String(value.handle || ''),
  title: String(value.title || ''),
  processId: Number(value.processId || 0),
  processName: String(value.processName || ''),
  bounds: toBounds(value.bounds || value.rect),
  minimized: value.minimized === true || value.isMinimized === true,
  visible: value.visible !== false && value.isValid !== false,
  foreground: value.foreground === true || value.isForeground === true
});

export const toMonitor = (value: Record<string, unknown>): MonitorInfo => ({
  ...toBounds(value.bounds),
  id: String(value.id || value.deviceName || value.name || ''),
  name: String(value.name || value.deviceName || value.id || ''),
  primary: value.primary === true || value.isPrimary === true,
  scale: Math.max(0.25, Number(value.scale || 1))
});

export const validBounds = (bounds: Bounds) =>
  Number.isFinite(bounds.left) && Number.isFinite(bounds.top)
  && Number.isFinite(bounds.right) && Number.isFinite(bounds.bottom)
  && bounds.right > bounds.left && bounds.bottom > bounds.top;
