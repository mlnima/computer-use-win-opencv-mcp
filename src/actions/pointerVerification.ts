import type { PreparedPointer } from '../types/input';
import { pointInBounds } from '../types/geometry';
import { getAccessibilityElement } from '../windows/accessibility';
import { getWindow, windowFromPoint } from '../windows/windows';

const sameBounds = (first: NonNullable<PreparedPointer['windowBounds']>, second: NonNullable<PreparedPointer['windowBounds']>) =>
  first.left === second.left && first.top === second.top && first.right === second.right && first.bottom === second.bottom;

const boundsNear = (first: NonNullable<PreparedPointer['elementScreenBounds']>, second: NonNullable<PreparedPointer['elementScreenBounds']>, tolerance = 3) =>
  Math.max(
    Math.abs(first.left - second.left),
    Math.abs(first.top - second.top),
    Math.abs(first.right - second.right),
    Math.abs(first.bottom - second.bottom)
  ) <= tolerance;

const semantic = (value?: string) => (value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

export const verifyPointerWindow = async (prepared: PreparedPointer, signal?: AbortSignal) => {
  if (!prepared.windowHandle || !prepared.windowBounds) return;
  const current = await getWindow(prepared.windowHandle, signal);
  if (!current || !sameBounds(current.bounds, prepared.windowBounds)) throw new Error('Target window moved, resized, or closed after pointer preparation.');
};

export const verifyPointerElement = async (prepared: PreparedPointer, signal?: AbortSignal) => {
  if (!prepared.windowHandle || !prepared.uiaRuntimeId || !prepared.elementScreenBounds) return;
  const current = await getAccessibilityElement(prepared.windowHandle, prepared.uiaRuntimeId, signal, prepared.target);
  if (!current || !current.enabled || current.offscreen) throw new Error('Prepared UI Automation element is stale, disabled, or offscreen.');
  if (!boundsNear(current.bounds, prepared.elementScreenBounds) || !pointInBounds(prepared.target, current.bounds)) {
    throw new Error('Prepared UI Automation element moved or changed geometry.');
  }
  if (semantic(current.role) !== semantic(prepared.uiaRole) || semantic(current.name) !== semantic(prepared.uiaName)
    || semantic(current.value) !== semantic(prepared.uiaValue)) {
    throw new Error('Prepared UI Automation element identity changed.');
  }
  if (prepared.uiaClickablePoint && !current.clickablePoint) throw new Error('Prepared UI Automation element is no longer clickable.');
  if (!current.pointerAncestors?.includes(prepared.uiaRuntimeId)) throw new Error('Prepared point no longer resolves to the intended UI Automation element.');
};

export const verifyPointerHit = async (prepared: Pick<PreparedPointer, 'windowHandle' | 'target'>, signal?: AbortSignal) => {
  const hit = await windowFromPoint(prepared.target, signal);
  if (!prepared.windowHandle) return hit;
  if (!hit) throw new Error('The target window could not be verified at the prepared point.');
  if (hit.handle !== prepared.windowHandle) throw new Error(`Prepared point is occluded by ${hit.title || hit.handle}.`);
  return hit;
};
