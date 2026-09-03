export type Point = { x: number; y: number };

export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type Size = { width: number; height: number };

export type MonitorInfo = Bounds & {
  id: string;
  name: string;
  primary: boolean;
  scale: number;
};

export type WindowInfo = {
  handle: string;
  title: string;
  processId: number;
  processName: string;
  bounds: Bounds;
  minimized: boolean;
  visible: boolean;
  foreground: boolean;
};

export const boundsWidth = (bounds: Bounds) => Math.max(0, bounds.right - bounds.left);

export const boundsHeight = (bounds: Bounds) => Math.max(0, bounds.bottom - bounds.top);

export const boundsCenter = (bounds: Bounds): Point => ({
  x: Math.round((bounds.left + bounds.right) / 2),
  y: Math.round((bounds.top + bounds.bottom) / 2)
});

export const pointInBounds = (point: Point, bounds: Bounds) =>
  point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
