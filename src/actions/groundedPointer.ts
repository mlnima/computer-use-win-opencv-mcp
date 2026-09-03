import { performance } from 'node:perf_hooks';
import type { InputExecution } from '../input/execution';
import { probeNative } from '../input/nativeActions';
import { clickPointerNative, movePointerNative, pointerResultNative, scrollPointerNative } from '../input/pointer';
import { runInputTransaction } from '../input/queue';
import type { Bounds } from '../types/geometry';
import { pointInBounds } from '../types/geometry';
import type { MouseButton, PreparedPointer } from '../types/input';
import type { Observation } from '../types/perception';
import type { RuntimeState } from '../types/runtime';
import { createObservation } from '../observation/create';
import { newId, recordTrace } from '../runtime/state';
import { getAccessibilityElement } from '../windows/accessibility';
import { focusWindow, getWindow, windowFromPoint } from '../windows/windows';
import { compactObservation, requireObservation, targetPoint } from './observations';
import { captureObservationSample, storedObservationSample, targetVisualRegion, verifyVisualSamples } from './visualVerification';
export type PointerOwner = { clientId: string; leaseId: string; signal?: AbortSignal };
export type PreparePointerOptions = {
  observationId: string;
  token: string;
  elementId?: string;
  x?: number;
  y?: number;
  allowRaw?: boolean;
  durationMs?: number;
  verification?: 'geometry' | 'visual' | 'none';
  hoverScreenshot?: boolean;
};
export type CommitPointerOptions = {
  prepareId: string;
  action: 'click' | 'doubleClick' | 'tripleClick' | 'rightClick' | 'middleClick' | 'x1Click' | 'x2Click' | 'scroll';
  deltaX?: number;
  deltaY?: number;
  observeAfter?: boolean;
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
const toScreenBounds = (observation: Observation, bounds: Bounds): Bounds => {
  const width = observation.bounds.right - observation.bounds.left;
  const height = observation.bounds.bottom - observation.bounds.top;
  return {
    left: Math.round(observation.bounds.left + bounds.left * width / observation.width),
    top: Math.round(observation.bounds.top + bounds.top * height / observation.height),
    right: Math.round(observation.bounds.left + bounds.right * width / observation.width),
    bottom: Math.round(observation.bounds.top + bounds.bottom * height / observation.height)
  };
};
const actionButton = (action: CommitPointerOptions['action']): MouseButton => {
  if (action === 'rightClick') return 'right';
  if (action === 'middleClick') return 'middle';
  if (action === 'x1Click') return 'x1';
  if (action === 'x2Click') return 'x2';
  return 'left';
};
const actionCount = (action: CommitPointerOptions['action']) => action === 'doubleClick' ? 2 : action === 'tripleClick' ? 3 : 1;
const verifyWindowGeometry = async (prepared: PreparedPointer, signal?: AbortSignal) => {
  if (!prepared.windowHandle || !prepared.windowBounds) return;
  const current = await getWindow(prepared.windowHandle, signal);
  if (!current || !sameBounds(current.bounds, prepared.windowBounds)) throw new Error('Target window moved, resized, or closed after pointer preparation.');
};

const verifyElementIdentity = async (prepared: PreparedPointer, signal?: AbortSignal) => {
  if (!prepared.windowHandle || !prepared.uiaRuntimeId || !prepared.elementScreenBounds) return;
  const current = await getAccessibilityElement(prepared.windowHandle, prepared.uiaRuntimeId, signal);
  if (!current || !current.enabled || current.offscreen) throw new Error('Prepared UI Automation element is stale, disabled, or offscreen.');
  if (!boundsNear(current.bounds, prepared.elementScreenBounds) || !pointInBounds(prepared.target, current.bounds)) {
    throw new Error('Prepared UI Automation element moved or changed geometry.');
  }
  if (prepared.uiaClickablePoint && (!current.clickablePoint || Math.abs(current.clickablePoint.x - prepared.target.x) > 3 || Math.abs(current.clickablePoint.y - prepared.target.y) > 3)) {
    throw new Error('Prepared UI Automation clickable point changed.');
  }
};

const verifyVisualState = async (state: RuntimeState, prepared: PreparedPointer, observation: Observation, execution: InputExecution) => {
  if (prepared.verification !== 'visual') return undefined;
  if (!prepared.visualBounds || !prepared.visualSample) throw new Error('Prepared local visual signature is unavailable.');
  const current = await captureObservationSample(state, observation, prepared.visualBounds, execution.signal);
  return verifyVisualSamples(state, prepared.visualSample, current, 'Target-local visual state changed after preparation');
};

const verifyHitTarget = async (prepared: Pick<PreparedPointer, 'windowHandle' | 'target'>, signal?: AbortSignal) => {
  const hit = await windowFromPoint(prepared.target, signal);
  if (!prepared.windowHandle) return hit;
  if (!hit) throw new Error('The target window could not be verified at the prepared point.');
  if (hit.handle !== prepared.windowHandle) throw new Error(`Prepared point is occluded by ${hit.title || hit.handle}.`);
  return hit;
};

const assertOwner = (prepared: PreparedPointer, owner: PointerOwner) => {
  if (prepared.clientId !== owner.clientId || prepared.leaseId !== owner.leaseId) {
    throw new Error('Pointer preparation belongs to another client or input lease.');
  }
};

const publicPrepared = (prepared: PreparedPointer) => ({
  id: prepared.id,
  observationId: prepared.observationId,
  target: prepared.target,
  elementId: prepared.elementId,
  windowHandle: prepared.windowHandle,
  preparedAt: prepared.preparedAt,
  expiresAt: prepared.expiresAt,
  imageHash: prepared.imageHash,
  verification: prepared.verification,
  windowBounds: prepared.windowBounds,
  elementScreenBounds: prepared.elementScreenBounds,
    uiaRuntimeId: prepared.uiaRuntimeId
});

export const prepareGroundedPointer = async (
  state: RuntimeState,
  options: PreparePointerOptions,
  owner: PointerOwner
) => {
  const observation = requireObservation(state, options.observationId, options.token);
  const target = targetPoint(observation, options);
  const elementScreenBounds = target.element ? toScreenBounds(observation, target.element.bounds) : undefined;
  const region = targetVisualRegion(target.screen, elementScreenBounds);
  const verification = options.verification || 'visual';
  const originalVisualSample = verification === 'visual' && !target.element?.uiaRuntimeId
    ? await storedObservationSample(state, observation, region, owner.signal)
    : undefined;
  const moved = await runInputTransaction(state, async ({ guard, execution }) => {
    const startedAt = performance.now();
    if (Date.parse(observation.expiresAt) <= Date.now()) throw new Error('Observation expired before pointer preparation.');
    const current = observation.window?.handle ? await getWindow(observation.window.handle, execution.signal) : undefined;
    if (observation.window && (!current || !sameBounds(current.bounds, observation.window.bounds))) throw new Error('Target window geometry is stale.');
    if (current) await focusWindow(current.handle, execution.signal);
    guard();
    const snapshotDifference = originalVisualSample
      ? verifyVisualSamples(state, originalVisualSample, await captureObservationSample(state, observation, region, execution.signal), 'Observed target changed before pointer preparation')
      : undefined;
    await movePointerNative(state, { ...target.screen, durationMs: options.durationMs ?? 180 }, execution);
    const hit = await verifyHitTarget({ windowHandle: current?.handle, target: target.screen }, execution.signal);
    if (!hit) throw new Error('No top-level window exists at the prepared point.');
    let visualSample: Buffer | undefined;
    const imageHash = state.screenshots.get(observation.screenshotId)?.hash || '';
    if (verification === 'visual') visualSample = await captureObservationSample(state, observation, region, execution.signal);
    guard();
    return {
      current,
      hit,
      visualSample,
      imageHash,
      snapshotDifference,
      input: await pointerResultNative(state, startedAt, execution)
    };
  }, { deadlineMs: 30_000, owner, signal: owner.signal });
  const now = Date.now();
  const prepared: PreparedPointer = {
    id: newId('prepare'),
    clientId: owner.clientId,
    leaseId: owner.leaseId,
    observationId: observation.id,
    target: target.screen,
    elementId: target.element?.id,
    windowHandle: moved.current?.handle || moved.hit?.handle,
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(Date.parse(observation.expiresAt), now + 10_000)).toISOString(),
    imageHash: moved.imageHash,
    verification,
    windowBounds: moved.current?.bounds || moved.hit?.bounds,
    elementScreenBounds,
    uiaRuntimeId: target.element?.uiaRuntimeId,
    uiaClickablePoint: target.element?.uiaClickablePoint,
    visualBounds: region,
    visualSample: moved.visualSample
  };
  const lease = state.control.lease;
  if (!lease || lease.id !== owner.leaseId || lease.clientId !== owner.clientId) throw new Error('Input lease ended during pointer preparation.');
  state.preparedPointers.set(prepared.id, prepared);
  const hover = options.hoverScreenshot === false ? undefined : await createObservation(state, {
    target: observation.window ? 'window' : observation.target === 'region' ? 'region' : 'desktop',
    windowHandle: observation.window?.handle,
    bounds: observation.target === 'region' ? observation.bounds : undefined,
    includeCursor: true,
    includeAccessibility: false,
    includeOcr: false,
    includeOpenCv: false,
    signal: owner.signal
  }).catch(() => undefined);
  recordTrace(state, 'pointer.prepare', {
    prepareId: prepared.id,
    observationId: observation.id,
    elementId: target.element?.id,
    target: target.screen,
    verification: prepared.verification,
    hitWindow: moved.hit?.handle
  });
  return {
    prepared: publicPrepared(prepared),
    element: target.element,
    input: moved.input,
    hitWindow: moved.hit,
    snapshotDifference: moved.snapshotDifference,
    hover: hover ? { ...compactObservation(hover), screenshotUri: hover.screenshotUri } : undefined
  };
};

export const consumeGroundedPointer = async <T>(
  state: RuntimeState,
  prepareId: string,
  owner: PointerOwner,
  operation: (prepared: PreparedPointer, execution: InputExecution) => Promise<T>
) => {
  const prepared = state.preparedPointers.get(prepareId);
  if (!prepared) throw new Error('Pointer preparation was not found or already consumed.');
  assertOwner(prepared, owner);
  const original = requireObservation(state, prepared.observationId);
  state.preparedPointers.delete(prepareId);
  if (Date.parse(prepared.expiresAt) <= Date.now()) throw new Error('Pointer preparation expired. Prepare again.');
  return await runInputTransaction(state, async ({ guard, execution }) => {
    if (Date.parse(prepared.expiresAt) <= Date.now()) throw new Error('Pointer preparation expired while waiting for input.');
    const probe = await probeNative(state, execution);
    if (Math.abs(probe.x - prepared.target.x) > 2 || Math.abs(probe.y - prepared.target.y) > 2) {
      throw new Error('Pointer moved after preparation. Prepare again.');
    }
    await verifyWindowGeometry(prepared, execution.signal);
    const visualDifference = await verifyVisualState(state, prepared, original, execution);
    await verifyElementIdentity(prepared, execution.signal);
    guard();
    const finalProbe = await probeNative(state, execution);
    if (Math.abs(finalProbe.x - prepared.target.x) > 2 || Math.abs(finalProbe.y - prepared.target.y) > 2) {
      throw new Error('Pointer moved during commit verification. Prepare again.');
    }
    const hitWindow = await verifyHitTarget(prepared, execution.signal);
    guard();
    if (Date.parse(prepared.expiresAt) <= Date.now()) throw new Error('Pointer preparation expired during commit verification.');
    const result = await operation(prepared, execution);
    guard();
    return { prepared, original, hitWindow, visualDifference, result };
  }, { deadlineMs: 30_000, owner, signal: owner.signal });
};

export const commitGroundedPointer = async (
  state: RuntimeState,
  options: CommitPointerOptions,
  owner: PointerOwner
) => {
  const startedAt = performance.now();
  const committed = await consumeGroundedPointer(state, options.prepareId, owner, async (_prepared, execution) => {
    if (options.action === 'scroll') await scrollPointerNative(state, { deltaX: options.deltaX, deltaY: options.deltaY }, execution);
    else await clickPointerNative(state, { button: actionButton(options.action), count: actionCount(options.action) }, execution);
    return await pointerResultNative(state, startedAt, execution);
  });
  recordTrace(state, 'pointer.commit', {
    prepareId: committed.prepared.id,
    observationId: committed.prepared.observationId,
    elementId: committed.prepared.elementId,
    action: options.action,
    target: committed.prepared.target,
    hitWindow: committed.hitWindow?.handle,
    visualDifference: committed.visualDifference,
    durationMs: committed.result.durationMs
  });
  const post = options.observeAfter === false ? undefined : await createObservation(state, {
    target: committed.original.window ? 'window' : committed.original.target === 'region' ? 'region' : 'desktop',
    windowHandle: committed.original.window?.handle,
    bounds: committed.original.target === 'region' ? committed.original.bounds : undefined,
    includeAccessibility: false,
    includeOcr: false,
    includeOpenCv: false,
    signal: owner.signal
  }).catch(() => undefined);
  return {
    consumedPrepareId: committed.prepared.id,
    input: committed.result,
    hitWindow: committed.hitWindow,
    visualDifference: committed.visualDifference,
    post: post ? { ...compactObservation(post), screenshotUri: post.screenshotUri } : undefined
  };
};
