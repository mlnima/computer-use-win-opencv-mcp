import type { ServerConfig } from '../config';
import type { LocateResult, ScreenElement } from '../types/perception';
import { renderSetOfMark } from './overlay';
import { rankWithVision } from './vision';

export type GroundingResult = LocateResult & { warning?: string };

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const tokens = (value: string) => [...new Set(normalize(value).split(' ').filter(Boolean))];

const positionScore = (query: string, element: ScreenElement, width: number, height: number) => {
  const x = element.safePoint.x / Math.max(1, width);
  const y = element.safePoint.y / Math.max(1, height);
  const checks = [
    { word: 'left', matches: x <= 0.4 },
    { word: 'right', matches: x >= 0.6 },
    { word: 'top', matches: y <= 0.4 },
    { word: 'bottom', matches: y >= 0.6 },
    { word: 'center', matches: x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7 }
  ];
  const requested = checks.filter((check) => query.includes(check.word));
  return requested.length > 0 && requested.every((check) => check.matches) ? 0.14 : 0;
};

const scoreElement = (element: ScreenElement, query: string, width: number, height: number) => {
  const normalizedQuery = normalize(query);
  const queryTokens = tokens(query);
  const name = normalize(element.name);
  const value = normalize(element.value || '');
  const role = normalize(element.role);
  const searchable = `${name} ${value} ${role}`.trim();
  const matchedTokens = queryTokens.filter((token) => searchable.split(' ').includes(token));
  const reasons: string[] = [];
  let score = element.confidence * 0.16;
  if (name && name === normalizedQuery) { score += 0.62; reasons.push('exact name'); }
  else if (name && (name.includes(normalizedQuery) || normalizedQuery.includes(name))) { score += 0.43; reasons.push('name phrase'); }
  if (value && value === normalizedQuery) { score += 0.42; reasons.push('exact value'); }
  if (role && queryTokens.includes(role)) { score += 0.26; reasons.push('role'); }
  if (queryTokens.length > 0 && matchedTokens.length > 0) {
    score += matchedTokens.length / queryTokens.length * 0.34;
    reasons.push(`${matchedTokens.length}/${queryTokens.length} terms`);
  }
  const positional = positionScore(normalizedQuery, element, width, height);
  if (positional > 0) { score += positional; reasons.push('position'); }
  if (element.sources.includes('uia')) { score += 0.08; reasons.push('accessibility'); }
  if (!element.enabled || element.offscreen) score -= 0.45;
  return { ...element, score: Math.max(0, Math.min(1.5, score)), reasons };
};

const deterministicMatches = (elements: ScreenElement[], query: string, width: number, height: number) =>
  elements.map((element) => scoreElement(element, query, width, height))
    .filter((element) => !query.trim() || element.score >= 0.14 && element.reasons.some((reason) => reason !== 'accessibility'))
    .sort((first, second) => second.score - first.score || second.confidence - first.confidence || first.id.localeCompare(second.id));

const spatialCandidates = (query: string, width: number, height: number) => {
  const columns = Math.max(1, Math.min(6, Math.floor(width)));
  const rows = Math.max(1, Math.min(4, Math.floor(height)));
  return Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const bounds = {
      left: Math.floor(column * width / columns),
      top: Math.floor(row * height / rows),
      right: Math.ceil((column + 1) * width / columns),
      bottom: Math.ceil((row + 1) * height / rows)
    };
    const element: ScreenElement = {
      id: `vision:grid:${row + 1}:${column + 1}`,
      role: 'sceneRegion',
      name: '',
      bounds,
      safePoint: { x: Math.floor((bounds.left + bounds.right - 1) / 2), y: Math.floor((bounds.top + bounds.bottom - 1) / 2) },
      confidence: 0.3,
      enabled: true,
      focused: false,
      offscreen: false,
      actions: ['click', 'drag'],
      sources: ['vision']
    };
    const scored = scoreElement(element, query, width, height);
    return { ...scored, reasons: [...scored.reasons, 'spatial vision proposal'] };
  });
};

const visionCandidates = (
  elements: ScreenElement[],
  ranked: ReturnType<typeof deterministicMatches>,
  query: string,
  width: number,
  height: number
) => {
  const rankedIds = new Set(ranked.map((element) => element.id));
  const remainder = elements.map((element) => scoreElement(element, query, width, height))
    .filter((element) => !rankedIds.has(element.id) && element.enabled && !element.offscreen)
    .sort((first, second) => second.confidence - first.confidence || first.id.localeCompare(second.id));
  const unnamed = remainder.filter((element) => !element.name.trim() && !element.value?.trim());
  const named = remainder.filter((element) => element.name.trim() || element.value?.trim());
  const entries = [...ranked.slice(0, 30), ...unnamed.slice(0, 28), ...named.slice(0, 18), ...ranked, ...remainder];
  const seen = new Set<string>();
  const local = entries.filter((element) => !seen.has(element.id) && Boolean(seen.add(element.id))).slice(0, 76);
  const spatial = spatialCandidates(query, width, height).filter((element) => !seen.has(element.id) && Boolean(seen.add(element.id)));
  return [...local, ...spatial].slice(0, 100);
};

export const locateElements = async (params: {
  config: ServerConfig;
  observationId: string;
  query: string;
  elements: ScreenElement[];
  image: Buffer;
  mimeType: string;
  width: number;
  height: number;
  limit?: number;
  useVision?: boolean;
}): Promise<GroundingResult> => {
  const ranked = deterministicMatches(params.elements, params.query, params.width, params.height);
  const limit = Math.max(1, Math.min(50, params.limit || 10));
  const visionConfigured = Boolean(params.config.visionApiUrl && params.config.visionModel);
  if (!params.useVision || !visionConfigured) return {
    observationId: params.observationId,
    query: params.query,
    matches: ranked.slice(0, limit),
    usedVision: false
  };
  const candidates = visionCandidates(params.elements, ranked, params.query, params.width, params.height);
  let overlay: Buffer;
  try {
    overlay = await renderSetOfMark(params.image, candidates, params.width, params.height, candidates.length);
  } catch (error) {
    return {
      observationId: params.observationId,
      query: params.query,
      matches: ranked.slice(0, limit),
      usedVision: false,
      warning: `Vision ranking unavailable: Set-of-Mark rendering failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const vision = await rankWithVision(params.config, params.query, overlay, 'image/png', candidates);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected = vision.ids.map((id) => byId.get(id))
    .filter((candidate): candidate is GroundingResult['matches'][number] => Boolean(candidate))
    .map((candidate) => ({ ...candidate, confidence: Math.max(0.72, candidate.confidence), score: Math.max(0.85, candidate.score) }));
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  const matches = [...selected, ...ranked.filter((candidate) => !selectedIds.has(candidate.id))].slice(0, limit).map((match) => selectedIds.has(match.id) ? {
    ...match,
    score: Math.max(1, match.score),
    sources: [...new Set([...match.sources, 'vision' as const])],
    reasons: [...match.reasons, 'vision rank']
  } : match);
  return {
    observationId: params.observationId,
    query: params.query,
    matches,
    usedVision: vision.used,
    warning: vision.warning
  };
};
