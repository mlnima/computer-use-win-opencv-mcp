import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { captureTarget } from '../capture/capture';
import { analyzeScreenshot } from '../perception/pipeline';
import { assertPerceptionDeadline, currentPerceptionDeadline, currentPerceptionSignal } from '../perception/deadline';
import { hashImage, imageDifferenceRatio } from '../perception/hash';
import { renderSetOfMark } from '../perception/overlay';
import type { Bounds } from '../types/geometry';
import type { Observation, ScreenshotRecord } from '../types/perception';
import type { RuntimeState } from '../types/runtime';
import { getAccessibility } from '../windows/accessibility';
import { getCursor, getWindow, listWindows } from '../windows/windows';
import { prepareObservationImage } from './image';
import { pruneObservationStorage, storeImageResource, storeTextResource } from './resources';
import { recordTrace } from '../runtime/state';

export type ObserveOptions = {
  target?: 'foreground' | 'window' | 'region' | 'desktop';
  windowHandle?: string;
  bounds?: Bounds;
  includeCursor?: boolean;
  includeAccessibility?: boolean;
  includeOcr?: boolean;
  includeOpenCv?: boolean;
  includeOverlay?: boolean;
  analysisLevel?: 'fast' | 'standard' | 'deep';
  maxAccessibilityNodes?: number;
  accessibilityTimeoutMs?: number;
  signal?: AbortSignal;
};

export type ObservationResult = Observation & {
  screenshotUri: string;
  sceneUri: string;
  overlayUri?: string;
  captureBackend: string;
  changeRatio?: number;
  stageMs: Record<string, number>;
};

const sameBounds = (first: Bounds, second: Bounds) =>
  first.left === second.left && first.top === second.top && first.right === second.right && first.bottom === second.bottom;

const assertObservationActive = (state: RuntimeState, signal?: AbortSignal) => {
  assertPerceptionDeadline();
  signal?.throwIfAborted();
  if (state.closing) throw Object.assign(new Error('Runtime is shutting down.'), { name: 'AbortError' });
};

const previousScreenshot = (state: RuntimeState, windowHandle: string | undefined, bounds: Bounds) =>
  [...state.screenshots.values()].reverse().find((screenshot) =>
    screenshot.windowHandle === windowHandle && sameBounds(screenshot.bounds, bounds));

const observationTarget = (windowHandle: string | undefined, bounds: Bounds | undefined): Observation['target'] =>
  bounds ? 'region' : windowHandle ? 'window' : 'desktop';

const requireTarget = (options: ObserveOptions, windows: Awaited<ReturnType<typeof listWindows>>) => {
  const requested = options.windowHandle
    ? windows.find((window) => window.handle === options.windowHandle)
    : options.target === 'desktop' || options.target === 'region' ? undefined : windows.find((window) => window.foreground);
  if (options.windowHandle && !requested) throw new Error(`Window not found: ${options.windowHandle}`);
  if (!requested && options.target !== 'desktop' && !options.bounds) throw new Error('No foreground window is available to observe.');
  return requested;
};

const accessibilityForTarget = async (
  handle: string | undefined,
  bounds: Bounds,
  state: RuntimeState,
  enabled: boolean,
  maxNodes: number,
  timeoutLimitMs: number,
  signal?: AbortSignal
) => {
  const startedAt = performance.now();
  if (!handle || !enabled) return { nodes: [], warning: undefined, elapsed: 0 };
  try {
    const deadlineAt = currentPerceptionDeadline();
    const timeoutMs = deadlineAt === undefined ? timeoutLimitMs : Math.max(1, Math.min(timeoutLimitMs, deadlineAt - Date.now()));
    return {
      nodes: await getAccessibility(handle, maxNodes, bounds, timeoutMs, signal),
      warning: undefined,
      elapsed: performance.now() - startedAt
    };
  } catch (error) {
    return {
      nodes: [],
      warning: `UI Automation unavailable: ${error instanceof Error ? error.message : String(error)}`,
      elapsed: performance.now() - startedAt
    };
  }
};

export const createObservation = async (
  state: RuntimeState,
  options: ObserveOptions = {}
): Promise<ObservationResult> => {
  pruneObservationStorage(state);
  const contextSignal = currentPerceptionSignal();
  const signal = options.signal && contextSignal ? AbortSignal.any([options.signal, contextSignal]) : options.signal || contextSignal;
  assertObservationActive(state, signal);
  const needsForeground = !options.windowHandle && options.target !== 'desktop' && options.target !== 'region';
  const windows = needsForeground ? await listWindows(signal, true) : [];
  const directWindow = options.windowHandle ? await getWindow(options.windowHandle, signal) : undefined;
  assertObservationActive(state, signal);
  const window = directWindow || requireTarget(options, windows);
  const capture = await captureTarget({
    windowHandle: window?.handle,
    window,
    bounds: options.bounds,
    includeCursor: options.includeCursor === true,
    signal
  });
  const capturedAt = new Date();
  assertObservationActive(state, signal);
  const prepared = await prepareObservationImage(capture.bytes, capture.width, capture.height, state.config);
  assertObservationActive(state, signal);
  const [cursor, accessibility] = await Promise.all([
    getCursor(signal).catch(() => ({ x: 0, y: 0 })),
    accessibilityForTarget(
      window?.handle,
      capture.bounds,
      state,
      options.includeAccessibility !== false,
      options.maxAccessibilityNodes || state.config.maxElements * 4,
      options.accessibilityTimeoutMs || 20_000,
      signal
    )
  ]);
  assertObservationActive(state, signal);
  const config = {
    ...state.config,
    ocrEnabled: options.includeOcr ?? state.config.ocrEnabled,
    openCvEnabled: options.includeOpenCv ?? state.config.openCvEnabled
  };
  const perception = await analyzeScreenshot({
    bytes: prepared.bytes,
    width: prepared.width,
    height: prepared.height,
    captureBounds: capture.bounds,
    accessibilityNodes: accessibility.nodes,
    config,
    analysisLevel: options.analysisLevel || 'standard',
    signal
  });
  perception.stageMs.accessibility = Math.round((perception.stageMs.accessibility + accessibility.elapsed) * 10) / 10;
  assertObservationActive(state, signal);
  const id = randomUUID();
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + state.config.observationTtlMs);
  const hash = hashImage(prepared.bytes);
  const previous = previousScreenshot(state, window?.handle, capture.bounds);
  const changeRatio = previous && previous.hash !== hash
    ? await imageDifferenceRatio(previous.bytes, prepared.bytes).catch(() => 1)
    : previous ? 0 : undefined;
  assertObservationActive(state, signal);
  const warnings = [...prepared.warnings, accessibility.warning, ...perception.warnings].filter((warning): warning is string => Boolean(warning));
  const overlayBytes = options.includeOverlay
    ? await renderSetOfMark(prepared.bytes, perception.elements, prepared.width, prepared.height, 160, state.config.screenshotMaxBytes).catch(() => undefined)
    : undefined;
  assertObservationActive(state, signal);
  const screenshotResource = storeImageResource(state, `snapshot-${id}`, prepared.mimeType, prepared.bytes, 'snapshots');
  const screenshot: ScreenshotRecord = {
    id: screenshotResource.id,
    observationId: id,
    mimeType: prepared.mimeType,
    bytes: prepared.bytes,
    width: prepared.width,
    height: prepared.height,
    bounds: capture.bounds,
    windowHandle: window?.handle,
    hash,
    capturedAt: capturedAt.toISOString()
  };
  state.screenshots.set(screenshot.id, screenshot);
  const overlayResource = overlayBytes
    ? storeImageResource(state, `overlay-${id}.png`, 'image/png', overlayBytes, 'overlays')
    : undefined;
  if (options.includeOverlay && !overlayResource) warnings.push('Set-of-Mark overlay rendering failed.');
  const sceneResource = storeTextResource(state, `scene-${id}.json`, 'application/json', JSON.stringify({
    observationId: id,
    captureBackend: capture.backend,
    bounds: capture.bounds,
    width: prepared.width,
    height: prepared.height,
    elements: perception.elements,
    sourceCounts: perception.sourceCounts,
    stageMs: perception.stageMs,
    warnings
  }), 'scenes');
  const observation: ObservationResult = {
    id,
    token,
    capturedAt: capturedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    target: observationTarget(window?.handle, options.bounds),
    window,
    screenshotId: screenshot.id,
    screenshotUri: screenshotResource.uri,
    sceneUri: sceneResource.uri,
    overlayUri: overlayResource?.uri,
    width: prepared.width,
    height: prepared.height,
    bounds: capture.bounds,
    cursor,
    elements: perception.elements,
    sourceCounts: perception.sourceCounts,
    imageChanged: changeRatio === undefined ? undefined : changeRatio > 0.002,
    changeRatio,
    warnings,
    captureBackend: capture.backend,
    stageMs: perception.stageMs
  };
  assertObservationActive(state, signal);
  if (!state.resources.has(screenshot.id) || !state.screenshots.has(screenshot.id)) throw new Error('Observation screenshot was evicted by the configured resource limits.');
  state.observations.set(id, observation);
  recordTrace(state, 'observation', {
    observationId: id,
    target: observation.target,
    windowHandle: window?.handle,
    captureBackend: capture.backend,
    dimensions: { width: prepared.width, height: prepared.height },
    elementCount: perception.elements.length,
    sourceCounts: perception.sourceCounts,
    stageMs: perception.stageMs,
    warningCount: warnings.length
  });
  return observation;
};
