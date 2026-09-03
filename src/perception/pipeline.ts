import { performance } from 'node:perf_hooks';
import type { ServerConfig } from '../config';
import type { AccessibilityNode, ElementSource, ScreenElement } from '../types/perception';
import type { Bounds } from '../types/geometry';
import { accessibilityElements } from './accessibility';
import { countElementSources, fuseElements } from './fusion';
import { detectTextElements } from './ocr';
import { detectVisualElements } from './opencv';
import { currentPerceptionDeadline } from './deadline';

export type PerceptionResult = {
  elements: ScreenElement[];
  sourceCounts: Partial<Record<ElementSource, number>>;
  warnings: string[];
  stageMs: Record<string, number>;
};

type PerceptionInput = {
  bytes: Buffer;
  width: number;
  height: number;
  captureBounds: Bounds;
  accessibilityNodes: AccessibilityNode[];
  config: ServerConfig;
};

const timed = async <T>(run: () => Promise<T>) => {
  const started = performance.now();
  const value = await run();
  return { value, elapsed: Math.round((performance.now() - started) * 10) / 10 };
};

export const analyzeScreenshot = async (input: PerceptionInput): Promise<PerceptionResult> => {
  const accessibilityStarted = performance.now();
  const accessibility = accessibilityElements(input.accessibilityNodes, input.captureBounds, input.width, input.height);
  const accessibilityMs = Math.round((performance.now() - accessibilityStarted) * 10) / 10;
  const stageLimit = Math.max(20, input.config.maxElements * 2);
  const deadlineAt = currentPerceptionDeadline();
  const [ocr, opencv] = await Promise.all([
    input.config.ocrEnabled
      ? timed(() => detectTextElements(input.bytes, input.config.ocrLanguages, input.width, input.height, stageLimit, input.config.runtimeDir, input.config.ocrLangPath, deadlineAt))
      : Promise.resolve({ value: { elements: [], warning: undefined }, elapsed: 0 }),
    input.config.openCvEnabled
      ? timed(() => detectVisualElements(input.bytes, stageLimit, deadlineAt))
      : Promise.resolve({ value: { elements: [], warning: undefined }, elapsed: 0 })
  ]);
  const fusionStarted = performance.now();
  const visionReserve = input.config.visionApiUrl && input.config.visionModel
    ? Math.min(24, Math.floor(input.config.maxElements / 10))
    : 0;
  const elements = fuseElements(accessibility, ocr.value.elements, opencv.value.elements, input.config.maxElements - visionReserve);
  const fusionMs = Math.round((performance.now() - fusionStarted) * 10) / 10;
  return {
    elements,
    sourceCounts: countElementSources(elements),
    warnings: [ocr.value.warning, opencv.value.warning].filter((warning): warning is string => Boolean(warning)),
    stageMs: { accessibility: accessibilityMs, ocr: ocr.elapsed, opencv: opencv.elapsed, fusion: fusionMs }
  };
};
