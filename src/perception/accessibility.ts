import type { AccessibilityNode, ScreenElement } from '../types/perception';
import type { Bounds } from '../types/geometry';
import { boundsArea, containsPoint, safePointForBounds, screenBoundsToImage, screenPointToImage } from './geometry';

const uniqueActions = (actions: ScreenElement['actions']) => [...new Set(actions)];

export const accessibilityElements = (
  nodes: AccessibilityNode[],
  captureBounds: Bounds,
  width: number,
  height: number
): ScreenElement[] => nodes.flatMap((node): ScreenElement[] => {
  const bounds = screenBoundsToImage(node.bounds, captureBounds, width, height);
  const clickablePoint = node.clickablePoint
    ? screenPointToImage(node.clickablePoint, captureBounds, width, height)
    : undefined;
  const validClickablePoint = clickablePoint && containsPoint(bounds, clickablePoint) ? clickablePoint : undefined;
  const safePoint = validClickablePoint || safePointForBounds(bounds);
  if (!safePoint || boundsArea(bounds) < 4 || node.offscreen) return [];
  return [{
    id: `uia:${node.runtimeId}`,
    role: node.role || 'control',
    name: node.name || '',
    value: node.value,
    bounds,
    safePoint,
    confidence: validClickablePoint ? 0.99 : 0.96,
    enabled: node.enabled,
    focused: node.focused,
    offscreen: node.offscreen,
    actions: uniqueActions(node.actions),
    sources: ['uia'],
    uiaRuntimeId: node.runtimeId,
    uiaClickablePoint: Boolean(validClickablePoint),
    uiaRole: node.role || 'control',
    uiaName: node.name || '',
    uiaValue: node.value,
    parentId: node.parentId,
    children: node.children
  }];
});
