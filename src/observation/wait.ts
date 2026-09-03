import { setTimeout as delay } from 'node:timers/promises';
import type { ScreenElement } from '../types/perception';
import type { RuntimeState } from '../types/runtime';
import { withPerceptionDeadline } from '../perception/deadline';
import { createObservation, type ObservationResult, type ObserveOptions } from './create';
import { locateObservation } from './locate';

export type WaitCondition =
  | { kind: 'visualChange'; minimumRatio?: number }
  | { kind: 'queryAppears'; query: string; minimumScore?: number; useVision?: boolean }
  | { kind: 'queryDisappears'; query: string; minimumScore?: number; useVision?: boolean };

export type WaitResult = {
  satisfied: boolean;
  condition: WaitCondition['kind'];
  elapsedMs: number;
  attempts: number;
  observation?: ObservationResult;
  matches: Array<ScreenElement & { score: number; reasons: string[] }>;
};

const queryMatches = async (
  state: RuntimeState,
  observation: ObservationResult,
  condition: Extract<WaitCondition, { query: string }>
) => {
  const located = await locateObservation(state, observation.id, condition.query, {
    limit: 20,
    useVision: condition.useVision
  });
  const minimum = Math.max(0, Math.min(1.5, condition.minimumScore ?? 0.35));
  return {
    matches: located.matches.filter((match) => match.score >= minimum),
    warning: located.warning
  };
};

const groundingUnavailable = (warnings: Array<string | undefined>) => warnings.some((warning) =>
  warning?.startsWith('UI Automation unavailable:') ||
  warning?.startsWith('OCR unavailable:') ||
  warning?.startsWith('OpenCV unavailable:') ||
  warning?.startsWith('Vision ranking unavailable:') ||
  warning === 'Vision model returned no valid element IDs.' ||
  warning === 'Vision model selected no elements.');

const evaluate = async (
  state: RuntimeState,
  observation: ObservationResult,
  condition: WaitCondition
) => {
  if (condition.kind === 'visualChange') {
    const minimum = Math.max(0, Math.min(1, condition.minimumRatio ?? 0.004));
    return { satisfied: (observation.changeRatio || 0) >= minimum, matches: [] };
  }
  const located = await queryMatches(state, observation, condition);
  const unavailable = groundingUnavailable([...observation.warnings, located.warning]);
  return {
    satisfied: condition.kind === 'queryAppears'
      ? located.matches.length > 0
      : located.matches.length === 0 && !unavailable,
    matches: located.matches
  };
};

const pollingOptions = (options: ObserveOptions, condition: WaitCondition): ObserveOptions => condition.kind === 'visualChange'
  ? { ...options, includeAccessibility: false, includeOcr: false, includeOpenCv: false, includeOverlay: false }
  : { ...options, includeOverlay: false };

const discardIntermediate = (state: RuntimeState, observation: ObservationResult) => {
  state.observations.delete(observation.id);
  state.screenshots.delete(observation.screenshotId);
  for (const uri of [observation.screenshotUri, observation.sceneUri, observation.overlayUri]) {
    const id = uri?.split('/').at(-1);
    if (id) state.resources.delete(id);
  }
};

export const waitForObservation = async (
  state: RuntimeState,
  condition: WaitCondition,
  observe: ObserveOptions = {},
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}
): Promise<WaitResult> => {
  const timeoutMs = Math.max(100, Math.min(120_000, Math.round(options.timeoutMs || 15_000)));
  const intervalMs = Math.max(100, Math.min(5_000, Math.round(options.intervalMs || 500)));
  const started = Date.now();
  const deadlineAt = started + timeoutMs;
  let attempts = 0;
  let observation: ObservationResult | undefined;
  let result = { satisfied: false, matches: [] as Array<ScreenElement & { score: number; reasons: string[] }> };
  try {
    observation = await withPerceptionDeadline(deadlineAt, () => createObservation(state, pollingOptions(observe, condition)), options.signal);
    attempts = 1;
    if (condition.kind !== 'visualChange' && Date.now() < deadlineAt) {
      result = await withPerceptionDeadline(deadlineAt, () => evaluate(state, observation!, condition), options.signal);
    }
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') throw error;
  }
  while (!result.satisfied && Date.now() < deadlineAt) {
    try { await delay(Math.min(intervalMs, Math.max(0, deadlineAt - Date.now())), undefined, options.signal ? { signal: options.signal } : undefined); }
    catch (error) { if ((error as Error)?.name === 'AbortError') break; throw error; }
    if (Date.now() >= deadlineAt) break;
    const previous = observation;
    try {
      observation = await withPerceptionDeadline(deadlineAt, () => createObservation(state, pollingOptions(observe, condition)), options.signal);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') break;
      throw error;
    }
    if (previous) discardIntermediate(state, previous);
    attempts += 1;
    result = Date.now() < deadlineAt
      ? await withPerceptionDeadline(deadlineAt, () => evaluate(state, observation!, condition), options.signal)
      : { satisfied: false, matches: [] };
  }
  return {
    satisfied: result.satisfied,
    condition: condition.kind,
    elapsedMs: Date.now() - started,
    attempts,
    observation,
    matches: result.matches
  };
};
