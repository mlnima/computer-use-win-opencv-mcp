import type { InputExecution } from '../input/execution';
import type { Observation, ScreenElement } from '../types/perception';
import { imageToScreenBounds } from './observations';
import { getAccessibilityElement, performAccessibilityAction } from '../windows/accessibility';
import { getWindow } from '../windows/windows';

type AccessibilityTarget = {
  observation?: Observation;
  element?: ScreenElement;
  handle: string;
  runtimeId: string;
  action: string;
  value: string;
};

const sameBounds = (first: NonNullable<Observation['window']>['bounds'], second: NonNullable<Observation['window']>['bounds']) =>
  first.left === second.left && first.top === second.top && first.right === second.right && first.bottom === second.bottom;

const boundsNear = (first: ScreenElement['bounds'], second: ScreenElement['bounds'], tolerance = 3) =>
  Math.max(
    Math.abs(first.left - second.left),
    Math.abs(first.top - second.top),
    Math.abs(first.right - second.right),
    Math.abs(first.bottom - second.bottom)
  ) <= tolerance;

const semantic = (value?: string) => (value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

export const performGroundedAccessibilityAction = async (
  target: AccessibilityTarget,
  guard: () => void,
  execution: InputExecution
) => {
  if (target.observation?.window) {
    const window = await getWindow(target.handle, execution.signal);
    if (!window || !sameBounds(window.bounds, target.observation.window.bounds)) throw new Error('Accessibility target window geometry is stale.');
  }
  if (target.element?.uiaRuntimeId) {
    const current = await getAccessibilityElement(target.handle, target.runtimeId, execution.signal);
    const bounds = target.observation ? imageToScreenBounds(target.observation, target.element.bounds) : target.element.bounds;
    if (!current || !current.enabled || current.offscreen || !boundsNear(current.bounds, bounds)
      || semantic(current.role) !== semantic(target.element.uiaRole) || semantic(current.name) !== semantic(target.element.uiaName)
      || semantic(current.value) !== semantic(target.element.uiaValue)) {
      throw new Error('Accessibility target element is stale, replaced, or unavailable.');
    }
  }
  guard();
  return await performAccessibilityAction(target.handle, target.runtimeId, target.action, target.value, execution.signal);
};
