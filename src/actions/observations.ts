import type { Point } from '../types/geometry';
import type { Observation, ScreenElement } from '../types/perception';
import type { RuntimeState } from '../types/runtime';
import { boundsHeight, boundsWidth, pointInBounds } from '../types/geometry';
import { containsPoint } from '../perception/geometry';
import type { InputExecution } from '../input/execution';
import type { MouseButton, TimelineEvent } from '../types/input';
import { getHeldInputState } from '../input/heldState';
import { probeNative } from '../input/nativeActions';
import { foregroundHandle, getWindow, windowFromPoint } from '../windows/windows';
import { inputSurfaceGuardScript } from './pointerVerification';
import { captureObservationSample, storedObservationSample, targetVisualRegion, verifyVisualSamples } from './visualVerification';

export const requireObservation = (state: RuntimeState, id: string, token?: string): Observation => {
  const observation = state.observations.get(id);
  if (!observation || Date.parse(observation.retainedUntil) <= Date.now()) {
    throw Object.assign(new Error(`Observation ${id} is ${observation ? 'expired' : 'missing'}. Capture a new observation and use its id, token and element IDs; do not retry the old target.`), {
      code: observation ? 'OBSERVATION_EXPIRED' : 'OBSERVATION_MISSING',
      recovery: { tool: 'computer_observe', arguments: { target: observation?.window ? 'window' : 'foreground', ...(observation?.window ? { windowHandle: observation.window.handle } : {}), mode: 'standard' } }
    });
  }
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
  if (!element && !input.allowRaw) throw new Error('Use a grounded elementId. Screenshot coordinates require allowRaw for an explicitly identified visual surface.');
  if (element && element.confidence < 0.25) throw new Error('Element confidence is too low for physical input.');
  if (element?.id.startsWith('vision:grid:') && !input.allowRaw) throw new Error('Vision grid targets are coarse. Observe this element as a region first, or set allowRaw to accept its center explicitly.');
  if (element?.evidence?.includes('no_unblocked_safe_point') && !input.allowRaw) throw new Error('This element has no verified child-free pointer point. Use computer_accessibility, refine the target, or set allowRaw explicitly.');
  const detectorBacked = element?.sources.some((source) => source === 'ocr' || source === 'opencv');
  if (element?.sources.includes('uia') && !element.uiaClickablePoint && !detectorBacked && !input.allowRaw) throw new Error('This UI Automation element has no verified clickable point. Use computer_accessibility, a detector-backed target, or allowRaw explicitly.');
  const local = element?.safePoint || (input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : undefined);
  if (!local) throw new Error('elementId or screenshot-local x and y are required.');
  return { local, screen: imageToScreenPoint(observation, local), element };
};

type InputSurface = { observationId: string; token: string; elementId?: string };
type DirectInput = { action: string; x?: number; y?: number; relative: boolean; button: MouseButton; mode: 'press' | 'down' | 'up'; deltaX?: number; deltaY?: number };

export const scrollPoint = (state: RuntimeState, surface: InputSurface | undefined, input: Pick<DirectInput, 'action' | 'x' | 'y' | 'relative'>) => {
  if (input.action !== 'scroll' || input.x !== undefined || input.y !== undefined || !surface) return input;
  const observation = requireObservation(state, surface.observationId, surface.token);
  const element = surface.elementId ? requireElement(observation, surface.elementId) : undefined;
  return { ...input, ...imageToScreenPoint(observation, element?.safePoint || { x: observation.width / 2, y: observation.height / 2 }), relative: false };
};

export const verifyInputSurface = async (state: RuntimeState, surface: InputSurface | undefined, input: TimelineEvent[] | DirectInput, execution: InputExecution) => {
  const events: TimelineEvent[] = Array.isArray(input) ? [...input].sort((a, b) => a.at - b.at) : [
    ...(input.x === undefined ? [] : [{ at: 0, type: 'move' as const, x: input.x, y: input.y!, relative: input.relative }]),
    ...(input.action === 'move' ? [] : input.action === 'scroll'
      ? [{ at: 0, type: 'wheel' as const, deltaX: input.deltaX, deltaY: input.deltaY }]
      : [{ at: 0, type: 'button' as const, button: input.button, mode: input.action === 'click' ? 'press' as const : input.mode }])
  ];
  const held = getHeldInputState(state).buttons.size > 0;
  const scrollOnly = !held && events.some((event) => event.type === 'wheel') && events.every((event) => event.type === 'move' || event.type === 'wheel');
  if (!events.some((event) => event.type === 'wheel' || event.type === 'button' && event.mode !== 'up' || event.type === 'move' && held)) return undefined;
  if (!surface) throw new Error('Raw pointer presses, scrolling, and drawing require surface: {observationId, token, elementId}. Scrolling accepts a fresh UI element or region; presses and drawing require a canvas surface. Use prepare/commit for UI clicks.');
  const observation = requireObservation(state, surface.observationId, surface.token);
  const element = surface.elementId ? requireElement(observation, surface.elementId) : undefined;
  if (!element && observation.target !== 'region') throw new Error('Input surface requires an elementId or a tightly bounded region observation.');
  if (!scrollOnly && element?.actions.some((action) => ['invoke', 'toggle', 'select', 'setValue', 'expand', 'collapse'].includes(action))) throw new Error('This is an actionable control, not an input surface. Use prepare/commit.');
  const outer = element ? imageToScreenBounds(observation, element.bounds) : observation.bounds;
  const bounds = { left: outer.left + 8, top: outer.top + 8, right: outer.right - 8, bottom: outer.bottom - 8 };
  let point: Point = await probeNative(state, execution);
  let first: Point | undefined = held ? point : undefined;
  for (const event of events) {
    if (event.type === 'move') {
      point = event.relative ? { x: point.x + event.x, y: point.y + event.y } : { x: event.x, y: event.y };
      if (!containsPoint(bounds, point)) throw new Error('Raw input leaves the observed surface interior. Keep at least 8 screen pixels inside its edges; use verified clicks for toolbars.');
    }
    if (event.type === 'wheel' || event.type === 'button' && event.mode !== 'up') {
      if (!containsPoint(bounds, point)) throw new Error('Raw input starts outside the observed surface interior.');
      first ||= point;
    }
  }
  if (!first || !containsPoint(bounds, first)) throw new Error('Held pointer input starts outside the observed surface interior.');
  const window = observation.window ? await getWindow(observation.window.handle, execution.signal) : await windowFromPoint(first, execution.signal);
  if (!window || !window.visible || window.minimized) throw new Error('Input surface window is unavailable.');
  if (observation.window && (window.processId !== observation.window.processId || Object.keys(window.bounds).some((key) => window.bounds[key as keyof typeof window.bounds] !== observation.window!.bounds[key as keyof typeof window.bounds]))) throw new Error('Input surface window changed since observation.');
  const region = targetVisualRegion(first, bounds);
  const original = await storedObservationSample(state, observation, region, execution.signal);
  verifyVisualSamples(state, original, await captureObservationSample(state, observation, region, execution.signal), 'Input surface changed before execution');
  const foreground = await foregroundHandle(execution.signal);
  execution.assertActive();
  return inputSurfaceGuardScript(window, bounds, foreground, new Date(Date.now() + state.config.observationTtlMs).toISOString(), element?.uiaRuntimeId, scrollOnly);
};

export const compactObservation = (observation: Observation) => ({
  id: observation.id,
  token: observation.token,
  capturedAt: observation.capturedAt,
  expiresAt: observation.expiresAt,
  retainedUntil: observation.retainedUntil,
  target: observation.target,
  window: observation.window,
  screenshotId: observation.screenshotId,
  width: observation.width,
  height: observation.height,
  bounds: observation.bounds,
  cursor: observation.cursor,
  elementsAnalyzed: observation.elementsAnalyzed,
  elementCount: observation.elements.length,
  sourceCounts: observation.sourceCounts,
  imageChanged: observation.imageChanged,
  warnings: observation.warnings
});
