import type { Bounds, Point } from '../types/geometry';

export const clipBounds = (bounds: Bounds, width: number, height: number): Bounds => ({
  left: Math.max(0, Math.min(width, Math.round(bounds.left))),
  top: Math.max(0, Math.min(height, Math.round(bounds.top))),
  right: Math.max(0, Math.min(width, Math.round(bounds.right))),
  bottom: Math.max(0, Math.min(height, Math.round(bounds.bottom)))
});

export const boundsArea = (bounds: Bounds) =>
  Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);

export const intersectionArea = (first: Bounds, second: Bounds) =>
  Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left)) *
  Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));

export const intersectionOverUnion = (first: Bounds, second: Bounds) => {
  const intersection = intersectionArea(first, second);
  const union = boundsArea(first) + boundsArea(second) - intersection;
  return union > 0 ? intersection / union : 0;
};

export const containment = (inner: Bounds, outer: Bounds) => {
  const area = boundsArea(inner);
  return area > 0 ? intersectionArea(inner, outer) / area : 0;
};

export const containsPoint = (bounds: Bounds, point: Point) =>
  point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;

export const unionBounds = (first: Bounds, second: Bounds): Bounds => ({
  left: Math.min(first.left, second.left),
  top: Math.min(first.top, second.top),
  right: Math.max(first.right, second.right),
  bottom: Math.max(first.bottom, second.bottom)
});

export const safePointForBounds = (bounds: Bounds, blockers: Bounds[] = []): Point | undefined => {
  const left = Math.ceil(bounds.left);
  const top = Math.ceil(bounds.top);
  const right = Math.ceil(bounds.right);
  const bottom = Math.ceil(bounds.bottom);
  if (left >= right || top >= bottom) return undefined;
  const clipped = blockers.map((blocker) => ({
    left: Math.max(left, Math.ceil(blocker.left)),
    top: Math.max(top, Math.ceil(blocker.top)),
    right: Math.min(right, Math.ceil(blocker.right)),
    bottom: Math.min(bottom, Math.ceil(blocker.bottom))
  })).filter((blocker) => blocker.left < blocker.right && blocker.top < blocker.bottom);
  const xEdges = [...new Set([left, right, ...clipped.flatMap((blocker) => [blocker.left, blocker.right])])].sort((first, second) => first - second);
  const candidates: Array<{ point: Point; clearance: number; area: number }> = [];
  for (let index = 0; index < xEdges.length - 1; index += 1) {
    const xStart = xEdges[index]!;
    const xEnd = xEdges[index + 1]!;
    if (xStart >= xEnd) continue;
    const x = Math.floor((xStart + xEnd - 1) / 2);
    const intervals = clipped.filter((blocker) => x >= blocker.left && x < blocker.right)
      .sort((first, second) => first.top - second.top || first.bottom - second.bottom);
    const gaps: Array<[number, number]> = [];
    let cursor = top;
    for (const interval of intervals) {
      if (interval.top > cursor) gaps.push([cursor, interval.top]);
      cursor = Math.max(cursor, interval.bottom);
      if (cursor >= bottom) break;
    }
    if (cursor < bottom) gaps.push([cursor, bottom]);
    for (const [yStart, yEnd] of gaps) {
      if (yStart >= yEnd) continue;
      const y = Math.floor((yStart + yEnd - 1) / 2);
      const point = { x, y };
      candidates.push({
        point,
        clearance: Math.min(x - xStart, xEnd - 1 - x, y - yStart, yEnd - 1 - y),
        area: (xEnd - xStart) * (yEnd - yStart)
      });
    }
  }
  return candidates.sort((first, second) => second.clearance - first.clearance || second.area - first.area || first.point.y - second.point.y || first.point.x - second.point.x)[0]?.point;
};

export const screenBoundsToImage = (
  bounds: Bounds,
  captureBounds: Bounds,
  width: number,
  height: number
): Bounds => {
  const captureWidth = Math.max(1, captureBounds.right - captureBounds.left);
  const captureHeight = Math.max(1, captureBounds.bottom - captureBounds.top);
  return clipBounds({
    left: (bounds.left - captureBounds.left) * width / captureWidth,
    top: (bounds.top - captureBounds.top) * height / captureHeight,
    right: (bounds.right - captureBounds.left) * width / captureWidth,
    bottom: (bounds.bottom - captureBounds.top) * height / captureHeight
  }, width, height);
};

export const screenPointToImage = (
  point: Point,
  captureBounds: Bounds,
  width: number,
  height: number
): Point => ({
  x: Math.round((point.x - captureBounds.left) * width / Math.max(1, captureBounds.right - captureBounds.left)),
  y: Math.round((point.y - captureBounds.top) * height / Math.max(1, captureBounds.bottom - captureBounds.top))
});
