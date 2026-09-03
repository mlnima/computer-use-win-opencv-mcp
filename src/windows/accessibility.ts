import type { Bounds, Point } from '../types/geometry';
import type { AccessibilityNode, ElementAction } from '../types/perception';
import { accessibilityActionScript, accessibilityElementScript, accessibilityTreeScript } from './accessibilityScripts';
import { normalizePowerShellArray, runPowerShellJson } from './powershell';
import { toBounds, validBounds } from './values';

const elementActions = new Set<ElementAction>([
  'click',
  'doubleClick',
  'rightClick',
  'focus',
  'invoke',
  'setValue',
  'toggle',
  'select',
  'expand',
  'collapse',
  'scroll',
  'drag'
]);

const toPoint = (value: unknown): Point | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const point = { x: Math.round(Number(item.x || 0)), y: Math.round(Number(item.y || 0)) };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined;
};

const toNode = (value: Record<string, unknown>): AccessibilityNode => {
  const actions = normalizePowerShellArray(value.actions as string | string[])
    .filter((action): action is ElementAction => elementActions.has(action as ElementAction));
  return {
    runtimeId: String(value.runtimeId || ''),
    depth: Math.max(0, Number(value.depth || 0)),
    role: String(value.role || ''),
    name: String(value.name || ''),
    value: value.value === undefined ? undefined : String(value.value),
    bounds: toBounds(value.bounds),
    enabled: value.enabled === true,
    focused: value.focused === true,
    offscreen: value.offscreen === true,
    actions,
    parentId: String(value.parentId || '') || undefined,
    clickablePoint: toPoint(value.clickablePoint),
    pointerAncestors: normalizePowerShellArray(value.pointerAncestors as string | string[]).map(String)
  };
};

const attachChildren = (nodes: AccessibilityNode[]) => {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    children.set(node.parentId, [...(children.get(node.parentId) || []), node.runtimeId]);
  }
  return nodes.map((node) => ({ ...node, children: children.get(node.runtimeId) }));
};

export const getAccessibility = async (
  handle: string,
  maxNodes: number,
  targetBounds?: Bounds,
  timeoutMs = 20_000,
  signal?: AbortSignal
): Promise<AccessibilityNode[]> => {
  if (!/^\d+$/.test(handle)) throw new Error(`Invalid window handle: ${handle}`);
  const limit = Math.max(1, Math.min(20_000, Math.round(maxNodes)));
  const raw = await runPowerShellJson<Record<string, unknown> | Record<string, unknown>[]>(
    accessibilityTreeScript(handle, limit, targetBounds),
    [],
    Math.max(1, Math.min(20_000, timeoutMs)),
    signal
  );
  return attachChildren(normalizePowerShellArray(raw).map(toNode).filter((node) =>
    node.runtimeId && validBounds(node.bounds)));
};

export const getAccessibilityElement = async (handle: string, runtimeId: string, signal?: AbortSignal, point?: Point): Promise<AccessibilityNode | null> => {
  if (!/^\d+$/.test(handle)) throw new Error(`Invalid window handle: ${handle}`);
  if (!/^-?\d+(\.-?\d+)*$/.test(runtimeId)) throw new Error(`Invalid UI Automation runtime ID: ${runtimeId}`);
  const raw = await runPowerShellJson<Record<string, unknown> | null>(accessibilityElementScript(handle, runtimeId, point), null, 20_000, signal);
  return raw ? toNode(raw) : null;
};

export const performAccessibilityAction = async (
  handle: string,
  runtimeId: string,
  action: string,
  value = '',
  signal?: AbortSignal
): Promise<unknown> => {
  if (!/^\d+$/.test(handle)) throw new Error(`Invalid window handle: ${handle}`);
  if (!/^-?\d+(\.-?\d+)*$/.test(runtimeId)) throw new Error(`Invalid UI Automation runtime ID: ${runtimeId}`);
  const supported = new Set(['focus', 'invoke', 'click', 'setValue', 'toggle', 'select', 'expand', 'collapse', 'scroll']);
  if (!supported.has(action)) throw new Error(`Unsupported UI Automation action: ${action}`);
  return await runPowerShellJson<unknown>(
    accessibilityActionScript(handle, runtimeId, action, value),
    null,
    20_000,
    signal
  );
};
