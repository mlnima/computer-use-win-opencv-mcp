import type { ElementSource, ScreenElement } from '../types/perception';
import { boundsArea, containment, containsPoint, intersectionOverUnion, safePointForBounds, unionBounds } from './geometry';

const sourcePriority: Record<ElementSource, number> = { uia: 4, vision: 3, ocr: 2, opencv: 1 };

const normalizedText = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

const unique = <T>(values: T[]) => [...new Set(values)];

const mergeConfidence = (first: number, second: number) =>
  Math.min(0.999, 1 - (1 - Math.max(0, first)) * (1 - Math.max(0, second)));

const sameSemanticElement = (first: ScreenElement, second: ScreenElement) => {
  const overlap = intersectionOverUnion(first.bounds, second.bounds);
  const firstText = normalizedText(`${first.name} ${first.value || ''}`);
  const secondText = normalizedText(`${second.name} ${second.value || ''}`);
  const textCompatible = !firstText || !secondText || firstText === secondText || firstText.includes(secondText) || secondText.includes(firstText);
  return overlap >= 0.9 && textCompatible && (first.role === second.role || first.sources.includes('opencv') || second.sources.includes('opencv'));
};

const candidateMatchScore = (current: ScreenElement, candidate: ScreenElement) => {
  const overlap = intersectionOverUnion(current.bounds, candidate.bounds);
  const candidateInside = containment(candidate.bounds, current.bounds);
  const currentInside = containment(current.bounds, candidate.bounds);
  const sourceBonus = current.sources.includes('uia')
    ? candidate.sources.includes('ocr') ? 0.18 : 0.05
    : current.sources.includes('opencv') ? 0.08 : 0;
  if (candidate.sources.includes('ocr')) return Math.max(overlap, candidateInside * 0.88) + sourceBonus;
  if (candidate.sources.includes('opencv')) return Math.max(overlap, Math.min(candidateInside, currentInside) * 0.62) + sourceBonus;
  return overlap + (sameSemanticElement(current, candidate) ? 0.4 : 0);
};

const matchThreshold = (candidate: ScreenElement) => candidate.sources.includes('ocr') ? 0.72 : candidate.sources.includes('opencv') ? 0.58 : 0.92;

const mergeElement = (target: ScreenElement, candidate: ScreenElement): ScreenElement => {
  const targetHasUia = target.sources.includes('uia');
  const candidateHasUia = candidate.sources.includes('uia');
  const preferCandidateName = !target.name && Boolean(candidate.name);
  const targetDetected = target.sources.some((source) => source === 'ocr' || source === 'opencv');
  const candidateDetected = candidate.sources.some((source) => source === 'ocr' || source === 'opencv');
  const detectedSafePoint = targetHasUia && candidateDetected
    ? candidate.safePoint
    : candidateHasUia && targetDetected ? target.safePoint : undefined;
  return {
    ...target,
    role: target.role === 'visual' || target.role === 'region' ? candidate.role || target.role : target.role,
    name: preferCandidateName ? candidate.name : target.name,
    value: target.value || candidate.value,
    bounds: targetHasUia ? target.bounds : candidateHasUia ? candidate.bounds : unionBounds(target.bounds, candidate.bounds),
    safePoint: target.uiaClickablePoint ? target.safePoint : candidate.uiaClickablePoint ? candidate.safePoint : detectedSafePoint || (targetHasUia ? target.safePoint : candidateHasUia ? candidate.safePoint : target.safePoint),
    confidence: mergeConfidence(target.confidence, candidate.confidence),
    enabled: target.enabled && candidate.enabled,
    focused: target.focused || candidate.focused,
    offscreen: target.offscreen && candidate.offscreen,
    actions: unique([...target.actions, ...candidate.actions]),
    sources: unique([...target.sources, ...candidate.sources]).sort((first, second) => sourcePriority[second] - sourcePriority[first]),
    uiaRuntimeId: target.uiaRuntimeId || candidate.uiaRuntimeId,
    uiaClickablePoint: target.uiaClickablePoint || candidate.uiaClickablePoint,
    uiaRole: target.uiaRole ?? candidate.uiaRole,
    uiaName: target.uiaName ?? candidate.uiaName,
    uiaValue: target.uiaValue ?? candidate.uiaValue,
    evidence: unique([...(target.evidence || []), ...(candidate.evidence || [])])
  };
};

const mergeCandidates = (elements: ScreenElement[], candidates: ScreenElement[]) => {
  const merged = [...elements];
  for (const candidate of candidates) {
    const matches = merged.map((element, index) => ({ index, score: candidateMatchScore(element, candidate) }))
      .filter((match) => match.score >= matchThreshold(candidate))
      .sort((first, second) => second.score - first.score || boundsArea(merged[first.index]!.bounds) - boundsArea(merged[second.index]!.bounds));
    const match = matches[0];
    match ? merged[match.index] = mergeElement(merged[match.index]!, candidate) : merged.push(candidate);
  }
  return merged;
};

const removeDuplicates = (elements: ScreenElement[]) => {
  const result: ScreenElement[] = [];
  for (const element of elements) {
    const index = result.findIndex((candidate) => sameSemanticElement(candidate, element));
    index >= 0 ? result[index] = mergeElement(result[index]!, element) : result.push(element);
  }
  return result;
};

const priorityScore = (element: ScreenElement) =>
  element.sources.reduce((score, source) => score + sourcePriority[source], 0) * 10 +
  element.confidence * 5 +
  Number(Boolean(element.name)) * 3 +
  Number(element.actions.length > 0) * 2 -
  Math.min(2, boundsArea(element.bounds) / 1_000_000);

const assignRelationships = (elements: ScreenElement[]) => elements.map((element) => {
  const containers = elements.filter((candidate) =>
    candidate.id !== element.id &&
    boundsArea(candidate.bounds) > boundsArea(element.bounds) * 1.08 &&
    containment(element.bounds, candidate.bounds) >= 0.98
  ).sort((first, second) => boundsArea(first.bounds) - boundsArea(second.bounds));
  const parent = containers[0];
  return { ...element, parentId: parent?.id };
}).map((element, _index, related) => ({
  ...element,
  children: related.filter((candidate) => candidate.parentId === element.id).map((candidate) => candidate.id)
}));

const isDescendant = (candidate: ScreenElement, ancestorId: string, byId: Map<string, ScreenElement>) => {
  const visited = new Set<string>();
  let parentId = candidate.parentId;
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
};

const updateSafePoints = (elements: ScreenElement[]) => {
  const byId = new Map(elements.map((element) => [element.id, element]));
  return elements.map((element) => {
    if (element.uiaClickablePoint) return element;
    const blockers = elements.filter((candidate) => isDescendant(candidate, element.id, byId)).map((candidate) => candidate.bounds);
    if (!blockers.some((blocker) => containsPoint(blocker, element.safePoint))) return element;
    const safePoint = safePointForBounds(element.bounds, blockers);
    return safePoint ? { ...element, safePoint } : { ...element, enabled: false, actions: [] };
  });
};

export const fuseElements = (
  accessibility: ScreenElement[],
  text: ScreenElement[],
  visual: ScreenElement[],
  maxElements: number
) => {
  const combined = removeDuplicates(mergeCandidates(mergeCandidates(removeDuplicates(accessibility), text), visual));
  const selected = combined.sort((first, second) => priorityScore(second) - priorityScore(first)).slice(0, maxElements);
  const ordered = selected.sort((first, second) => first.bounds.top - second.bounds.top || first.bounds.left - second.bounds.left || boundsArea(first.bounds) - boundsArea(second.bounds));
  const identified = ordered.map((element, index) => ({ ...element, id: `e${index + 1}`, parentId: undefined, children: undefined }));
  return updateSafePoints(assignRelationships(identified));
};

export const countElementSources = (elements: ScreenElement[]) => elements.reduce<Partial<Record<ElementSource, number>>>((counts, element) => {
  for (const source of element.sources) counts[source] = (counts[source] || 0) + 1;
  return counts;
}, {});
