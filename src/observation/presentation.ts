import type { ElementSource, LocateResult, ScreenElement } from '../types/perception';

const sourceWeight = { uia: 10, ocr: 7, opencv: 5, vision: 6 } as const;
const sourceOrder: ElementSource[] = ['uia', 'ocr', 'opencv', 'vision'];

const elementCell = (element: ScreenElement, width: number, height: number) => {
  const columns = 4;
  const rows = 3;
  const x = (element.bounds.left + element.bounds.right) / 2;
  const y = (element.bounds.top + element.bounds.bottom) / 2;
  const column = Math.max(0, Math.min(columns - 1, Math.floor(x / Math.max(1, width) * columns)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor(y / Math.max(1, height) * rows)));
  return `${row}:${column}`;
};

const elementPriority = (element: ScreenElement) =>
  Math.max(...element.sources.map((source) => sourceWeight[source]), 0) +
  Math.max(0, element.sources.length - 1) * 3 +
  element.confidence * 8 +
  Number(Boolean(element.name.trim())) * 4 +
  Number(Boolean(element.value?.trim())) * 2 +
  Number(element.actions.length > 0) * 3 +
  Number(element.focused) * 5 -
  Number(!element.enabled) * 20 -
  Number(element.offscreen) * 20;

export const selectDiverseElements = (elements: ScreenElement[], limit: number, width: number, height: number) => {
  const maximum = Math.max(0, Math.min(limit, elements.length));
  const ranked = [...elements].sort((first, second) => elementPriority(second) - elementPriority(first) || first.id.localeCompare(second.id));
  const selected: ScreenElement[] = [];
  const selectedIds = new Set<string>();
  const add = (element?: ScreenElement) => {
    if (!element || selected.length >= maximum || selectedIds.has(element.id)) return;
    selected.push(element);
    selectedIds.add(element.id);
  };
  for (const source of sourceOrder) add(ranked.find((element) => element.sources.includes(source)));
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 4; column += 1) {
    add(ranked.find((element) => elementCell(element, width, height) === `${row}:${column}`));
  }
  for (const element of ranked) add(element);
  return selected;
};

export const locateEvidenceReasons = (matches: LocateResult['matches']) => {
  const top = matches[0];
  const second = matches[1];
  const reasons: Array<'no_matches' | 'ambiguous_matches' | 'opencv_only'> = [];
  if (!top) reasons.push('no_matches');
  if (top && (top.score < 0.52 || Boolean(second && top.score - second.score < 0.12))) reasons.push('ambiguous_matches');
  if (top?.sources.length === 1 && top.sources[0] === 'opencv') reasons.push('opencv_only');
  return reasons;
};

export const selectEvidenceElements = (
  elements: ScreenElement[],
  matches: LocateResult['matches'],
  limit: number,
  width: number,
  height: number
) => {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const matched = matches.slice(0, Math.min(20, limit)).map((match) => byId.get(match.id)).filter((element): element is ScreenElement => Boolean(element));
  const matchedIds = new Set(matched.map((element) => element.id));
  const context = selectDiverseElements(elements.filter((element) => !matchedIds.has(element.id)), limit - matched.length, width, height);
  return [...matched, ...context];
};
