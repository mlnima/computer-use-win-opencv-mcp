import type { InputExecution } from '../input/execution';
import type { Bounds, Point, WindowInfo } from '../types/geometry';
import { pointInBounds } from '../types/geometry';
import type { DragState } from '../types/input';
import type { Observation, ScreenElement } from '../types/perception';
import type { RuntimeState } from '../types/runtime';
import { getAccessibilityElement } from '../windows/accessibility';
import { getWindow, windowFromPoint } from '../windows/windows';
import { imageToScreenBounds } from './observations';
import { captureObservationSample, captureWindowSample, storedObservationSample, targetVisualRegion, verifyVisualSamples } from './visualVerification';

export type DragDestination = {
  observation?: Observation;
  element?: ScreenElement;
  point: Point;
};

export type PreparedDragDestination = DragDestination & {
  expectedWindow?: WindowInfo;
  elementBounds?: Bounds;
  uiaRuntimeId?: string;
  uiaRole?: string;
  uiaName?: string;
  uiaValue?: string;
  visualBounds?: Bounds;
  snapshotDifference?: number;
};

const sameBounds = (first: Bounds, second: Bounds) =>
  first.left === second.left && first.top === second.top && first.right === second.right && first.bottom === second.bottom;

const boundsNear = (first: Bounds, second: Bounds, tolerance = 3) =>
  Math.max(
    Math.abs(first.left - second.left),
    Math.abs(first.top - second.top),
    Math.abs(first.right - second.right),
    Math.abs(first.bottom - second.bottom)
  ) <= tolerance;

const semantic = (value?: string) => (value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

export const preflightDragDestination = async (
  state: RuntimeState,
  destination: DragDestination,
  execution: InputExecution
): Promise<PreparedDragDestination> => {
  const expectedWindow = destination.observation?.window;
  const currentWindow = expectedWindow ? await getWindow(expectedWindow.handle, execution.signal) : undefined;
  execution.assertActive();
  if (expectedWindow && (!currentWindow || !sameBounds(currentWindow.bounds, expectedWindow.bounds))) {
    throw new Error('Drag destination window geometry is stale.');
  }
  const elementBounds = destination.observation && destination.element
    ? imageToScreenBounds(destination.observation, destination.element.bounds)
    : undefined;
  const uiaRuntimeId = destination.element?.uiaRuntimeId;
  const uiaRole = destination.element?.uiaRole;
  const uiaName = destination.element?.uiaName;
  const uiaValue = destination.element?.uiaValue;
  if (uiaRuntimeId && expectedWindow && elementBounds) {
    const accessible = await getAccessibilityElement(expectedWindow.handle, uiaRuntimeId, execution.signal);
    execution.assertActive();
    if (!accessible || !accessible.enabled || accessible.offscreen || !boundsNear(accessible.bounds, elementBounds)
      || semantic(accessible.role) !== semantic(uiaRole) || semantic(accessible.name) !== semantic(uiaName)
      || semantic(accessible.value) !== semantic(uiaValue)
      || !pointInBounds(destination.point, accessible.bounds)) {
      throw new Error('Drag destination element is stale, moved, or unavailable.');
    }
  }
  const visualBounds = destination.observation ? targetVisualRegion(destination.point, elementBounds) : undefined;
  let snapshotDifference: number | undefined;
  if (destination.observation && visualBounds) {
    const hit = await windowFromPoint(destination.point, execution.signal);
    execution.assertActive();
    if (!hit || expectedWindow && hit.handle !== expectedWindow.handle) throw new Error('Observed drag destination is currently occluded.');
    const original = await storedObservationSample(state, destination.observation, visualBounds, execution.signal);
    const current = await captureObservationSample(state, destination.observation, visualBounds, execution.signal);
    snapshotDifference = verifyVisualSamples(state, original, current, 'Observed drag destination changed before movement');
  }
  return { ...destination, expectedWindow: currentWindow || expectedWindow, elementBounds, uiaRuntimeId, uiaRole, uiaName, uiaValue, visualBounds, snapshotDifference };
};

export const bindDragDestination = async (
  state: RuntimeState,
  drag: DragState,
  destination: PreparedDragDestination,
  execution: InputExecution
) => {
  const hit = await windowFromPoint(drag.point, execution.signal);
  execution.assertActive();
  if (!hit || destination.expectedWindow && hit.handle !== destination.expectedWindow.handle) {
    throw new Error('Drag destination is occluded by another window.');
  }
  const visualBounds = destination.observation ? targetVisualRegion(drag.point, destination.elementBounds) : undefined;
  const visualSample = visualBounds
    ? await captureWindowSample(state, hit.handle, hit.bounds, visualBounds, execution.signal)
    : undefined;
  execution.assertActive();
  Object.assign(drag, {
    destinationWindowHandle: hit.handle,
    destinationWindowBounds: hit.bounds,
    destinationUiaRuntimeId: destination.uiaRuntimeId,
    destinationUiaRole: destination.uiaRole,
    destinationUiaName: destination.uiaName,
    destinationUiaValue: destination.uiaValue,
    destinationElementBounds: destination.elementBounds,
    destinationVisualBounds: visualBounds,
    destinationVisualSample: visualSample
  });
  return hit;
};

export const verifyDragDestination = async (
  state: RuntimeState,
  drag: DragState,
  execution: InputExecution
) => {
  if (!drag.destinationWindowHandle || !drag.destinationWindowBounds) {
    throw new Error('Drag destination has not been verified.');
  }
  const current = await getWindow(drag.destinationWindowHandle, execution.signal);
  execution.assertActive();
  if (!current || !sameBounds(current.bounds, drag.destinationWindowBounds)) {
    throw new Error('Drag destination window moved, resized, or closed before release.');
  }
  if (drag.destinationUiaRuntimeId && drag.destinationElementBounds) {
    const accessible = await getAccessibilityElement(current.handle, drag.destinationUiaRuntimeId, execution.signal);
    execution.assertActive();
    if (!accessible || !accessible.enabled || accessible.offscreen
      || !boundsNear(accessible.bounds, drag.destinationElementBounds) || !pointInBounds(drag.point, accessible.bounds)) {
      throw new Error('Drag destination element changed before release.');
    }
    if (semantic(accessible.role) !== semantic(drag.destinationUiaRole) || semantic(accessible.name) !== semantic(drag.destinationUiaName)
      || semantic(accessible.value) !== semantic(drag.destinationUiaValue)) throw new Error('Drag destination element identity changed before release.');
  }
  let visualDifference: number | undefined;
  if (drag.destinationVisualBounds && drag.destinationVisualSample) {
    const sample = await captureWindowSample(state, current.handle, current.bounds, drag.destinationVisualBounds, execution.signal);
    visualDifference = verifyVisualSamples(state, drag.destinationVisualSample, sample, 'Drag destination visual state changed before release');
  }
  const hit = await windowFromPoint(drag.point, execution.signal);
  execution.assertActive();
  if (hit?.handle !== drag.destinationWindowHandle) throw new Error('Drag destination became occluded before release.');
  return { hitWindow: hit, visualDifference };
};
