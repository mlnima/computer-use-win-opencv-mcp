import { locateElements, type GroundingResult } from '../perception/locate';
import { renderSetOfMark } from '../perception/overlay';
import { assertPerceptionDeadline } from '../perception/deadline';
import type { Observation } from '../types/perception';
import type { RuntimeState } from '../types/runtime';
import { readStoredResource, storeImageResource } from './resources';

const assertRuntimeActive = (state: RuntimeState) => {
  assertPerceptionDeadline();
  if (state.closing) throw Object.assign(new Error('Runtime is shutting down.'), { name: 'AbortError' });
};

const refreshScene = (state: RuntimeState, observation: Observation) => {
  const resource = observation.sceneUri ? readStoredResource(state, observation.sceneUri) : undefined;
  if (!resource?.text) return;
  const scene = JSON.parse(resource.text) as Record<string, unknown>;
  resource.text = JSON.stringify({ ...scene, elements: observation.elements, sourceCounts: observation.sourceCounts });
};

const getObservationData = (state: RuntimeState, observationId: string) => {
  const observation = state.observations.get(observationId);
  if (!observation || Date.parse(observation.expiresAt) <= Date.now()) throw new Error('Observation is missing or expired. Capture a new observation.');
  const screenshot = state.screenshots.get(observation.screenshotId);
  if (!screenshot) throw new Error('Observation screenshot is unavailable. Capture a new observation.');
  return { observation, screenshot };
};

export const locateObservation = async (
  state: RuntimeState,
  observationId: string,
  query: string,
  options: { limit?: number; useVision?: boolean } = {}
): Promise<GroundingResult> => {
  const { observation, screenshot } = getObservationData(state, observationId);
  const requestedLimit = Math.max(1, Math.min(50, options.limit || 10));
  const result = await locateElements({
    config: state.config,
    observationId,
    query,
    elements: observation.elements,
    image: screenshot.bytes,
    mimeType: screenshot.mimeType,
    width: screenshot.width,
    height: screenshot.height,
    limit: Math.min(50, requestedLimit + 24),
    useVision: options.useVision
  });
  assertRuntimeActive(state);
  const existing = new Set(observation.elements.map((element) => element.id));
  let promoted = false;
  for (const match of result.matches) {
    if (!match.id.startsWith('vision:grid:') || existing.has(match.id) || observation.elements.length >= state.config.maxElements) continue;
    const { score: _score, reasons: _reasons, ...element } = match;
    observation.elements.push(element);
    observation.sourceCounts.vision = (observation.sourceCounts.vision || 0) + 1;
    existing.add(element.id);
    promoted = true;
  }
  if (promoted) refreshScene(state, observation);
  return {
    ...result,
    matches: result.matches.filter((match) => !match.id.startsWith('vision:grid:') || existing.has(match.id)).slice(0, requestedLimit)
  };
};

export const createObservationOverlay = async (
  state: RuntimeState,
  observationId: string,
  elementIds?: string[]
) => {
  const { observation, screenshot } = getObservationData(state, observationId);
  const allowed = elementIds ? new Set(elementIds) : undefined;
  const elements = allowed ? observation.elements.filter((element) => allowed.has(element.id)) : observation.elements;
  const bytes = await renderSetOfMark(screenshot.bytes, elements, screenshot.width, screenshot.height, 160, state.config.screenshotMaxBytes);
  assertRuntimeActive(state);
  return storeImageResource(state, `overlay-${observationId}.png`, 'image/png', bytes, 'overlays');
};
