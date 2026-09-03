import { captureTarget } from '../capture/capture';
import { sampleDifferenceRatio, sampleScreenRegion } from '../perception/hash';
import type { Bounds, Point } from '../types/geometry';
import type { Observation } from '../types/perception';
import type { RuntimeState } from '../types/runtime';

const assertActive = (state: RuntimeState, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  if (state.closing) throw Object.assign(new Error('Runtime is shutting down.'), { name: 'AbortError' });
};

export const targetVisualRegion = (point: Point, bounds?: Bounds): Bounds => {
  const width = bounds ? bounds.right - bounds.left : 0;
  const height = bounds ? bounds.bottom - bounds.top : 0;
  const padding = Math.max(8, Math.min(32, Math.round(Math.max(width, height) * 0.12)));
  const halfWidth = Math.min(180, Math.max(28, Math.ceil(width / 2) + padding));
  const halfHeight = Math.min(140, Math.max(28, Math.ceil(height / 2) + padding));
  return {
    left: point.x - halfWidth,
    top: point.y - halfHeight,
    right: point.x + halfWidth,
    bottom: point.y + halfHeight
  };
};

export const storedObservationSample = async (
  state: RuntimeState,
  observation: Observation,
  region: Bounds,
  signal?: AbortSignal
) => {
  assertActive(state, signal);
  const screenshot = state.screenshots.get(observation.screenshotId);
  if (!screenshot) throw new Error('Observation screenshot is unavailable. Capture a new observation.');
  const sample = await sampleScreenRegion(screenshot.bytes, screenshot.bounds, region);
  assertActive(state, signal);
  return sample;
};

export const captureObservationSample = async (
  state: RuntimeState,
  observation: Observation,
  region: Bounds,
  signal?: AbortSignal
) => {
  assertActive(state, signal);
  const capture = await captureTarget({
    windowHandle: observation.window?.handle,
    bounds: region,
    includeCursor: false,
    signal
  });
  assertActive(state, signal);
  const sample = await sampleScreenRegion(capture.bytes, capture.bounds, region);
  assertActive(state, signal);
  return sample;
};

export const captureWindowSample = async (
  state: RuntimeState,
  windowHandle: string,
  windowBounds: Bounds,
  region: Bounds,
  signal?: AbortSignal
) => {
  assertActive(state, signal);
  const capture = await captureTarget({ windowHandle, bounds: windowBounds, includeCursor: false, signal });
  assertActive(state, signal);
  const sample = await sampleScreenRegion(capture.bytes, capture.bounds, region);
  assertActive(state, signal);
  return sample;
};

export const verifyVisualSamples = (
  state: RuntimeState,
  previous: Buffer,
  current: Buffer,
  message: string
) => {
  const difference = sampleDifferenceRatio(previous, current);
  if (difference > state.config.visualChangeThreshold) throw new Error(`${message} (${difference.toFixed(3)}).`);
  return difference;
};
