import type { Point } from '../types/geometry';
import type { Observation, ScreenElement } from '../types/perception';
import type { RuntimeState } from '../types/runtime';
import { boundsHeight, boundsWidth, pointInBounds } from '../types/geometry';
import { containsPoint } from '../perception/geometry';

export const requireObservation = (state: RuntimeState, id: string, token?: string): Observation => {
  const observation = state.observations.get(id);
  if (!observation) throw new Error('Observation was not found. Capture a new observation.');
  if (Date.parse(observation.expiresAt) <= Date.now()) throw new Error('Observation is stale. Capture a new observation.');
  if (token !== undefined && observation.token !== token) throw new Error('Observation token does not match.');
  return observation;
};

export const requireElement = (observation: Observation, elementId: string): ScreenElement => {
  const element = observation.elements.find((entry) => entry.id === elementId);
  if (!element) throw new Error('Element does not belong to this observation. Locate it again.');
  if (!element.enabled || element.offscreen) throw new Error('Element is disabled or offscreen.');
  return element;
};

export const imageToScreenPoint = (observation: Observation, point: Point): Point => {
  if (!pointInBounds(point, { left: 0, top: 0, right: observation.width, bottom: observation.height })) {
    throw new Error('Point is outside the observation image.');
  }
  return {
    x: Math.round(observation.bounds.left + point.x * boundsWidth(observation.bounds) / Math.max(1, observation.width)),
    y: Math.round(observation.bounds.top + point.y * boundsHeight(observation.bounds) / Math.max(1, observation.height))
  };
};

export const imageToScreenBounds = (observation: Observation, bounds: { left: number; top: number; right: number; bottom: number }) => ({
  left: Math.round(observation.bounds.left + bounds.left * boundsWidth(observation.bounds) / Math.max(1, observation.width)),
  top: Math.round(observation.bounds.top + bounds.top * boundsHeight(observation.bounds) / Math.max(1, observation.height)),
  right: Math.round(observation.bounds.left + bounds.right * boundsWidth(observation.bounds) / Math.max(1, observation.width)),
  bottom: Math.round(observation.bounds.top + bounds.bottom * boundsHeight(observation.bounds) / Math.max(1, observation.height))
});

export const targetPoint = (
  observation: Observation,
  input: { elementId?: string; x?: number; y?: number; allowRaw?: boolean }
) => {
  const element = input.elementId ? requireElement(observation, input.elementId) : undefined;
  if (element && element.confidence < 0.25) throw new Error('Element confidence is too low for physical input.');
  if (element?.id.startsWith('vision:grid:') && !input.allowRaw) throw new Error('Vision grid targets are coarse. Observe this element as a region first, or set allowRaw to accept its center explicitly.');
  if (element?.sources.includes('uia') && !element.uiaClickablePoint && !element.sources.includes('opencv') && !input.allowRaw) throw new Error('This UI Automation element has no verified clickable point. Use computer_accessibility, a detector-backed target, or allowRaw explicitly.');
  const local = element?.safePoint || (input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : undefined);
  if (!local) throw new Error('elementId or screenshot-local x and y are required.');
  if (!element && !input.allowRaw) {
    const overlaps = observation.elements.filter((entry) => entry.enabled && !entry.offscreen && entry.confidence >= 0.7 && containsPoint(entry.bounds, local));
    if (overlaps.length) throw new Error(`Raw point overlaps grounded element ${overlaps[0].id}. Use its elementId or set allowRaw.`);
  }
  return { local, screen: imageToScreenPoint(observation, local), element };
};

export const compactObservation = (observation: Observation) => ({
  id: observation.id,
  token: observation.token,
  capturedAt: observation.capturedAt,
  expiresAt: observation.expiresAt,
  target: observation.target,
  window: observation.window,
  screenshotId: observation.screenshotId,
  width: observation.width,
  height: observation.height,
  bounds: observation.bounds,
  cursor: observation.cursor,
  elementCount: observation.elements.length,
  sourceCounts: observation.sourceCounts,
  imageChanged: observation.imageChanged,
  warnings: observation.warnings
});
