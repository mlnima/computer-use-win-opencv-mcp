import type { RuntimeState } from '../types/runtime';
import { withPerceptionDeadline } from '../perception/deadline';
import { createObservation, type ObserveOptions } from './create';
import { observationValue, presentElement, selectDiverseElements } from './presentation';

export const createPostObservation = async (state: RuntimeState, options: ObserveOptions = {}, inlineImage?: boolean) =>
  await withPerceptionDeadline(Date.now() + 30_000, async () => {
    const observation = await createObservation(state, {
      ...options,
      analysisLevel: 'fast',
      maxAccessibilityNodes: 400,
      accessibilityTimeoutMs: 5_000,
      includeAccessibility: true,
      includeOpenCv: true,
      includeOcr: false
    });
    const candidates = selectDiverseElements(observation.elements, 80, observation.width, observation.height);
    let bytes = 2;
    const elements = candidates.filter((element) => {
      const size = Buffer.byteLength(JSON.stringify(presentElement(element))) + 1;
      if (bytes + size > state.config.elementResponseMaxBytes) return false;
      bytes += size;
      return true;
    });
    const semantic = elements.some((element) => element.enabled && (element.name || element.value)
      && element.sources.some((source) => source === 'uia' || source === 'ocr'));
    return { ...observationValue(observation, elements), inlineImage: inlineImage ?? !semantic };
  }, options.signal);
