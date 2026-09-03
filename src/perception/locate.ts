import type { ServerConfig } from '../config';
import type { LocateResult, ScreenElement } from '../types/perception';
import { renderSetOfMark } from './overlay';
import { rankWithVision } from './vision';
export type GroundingResult = LocateResult & { warning?: string };
const exactText = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const orderedTerms = (value: string) => normalize(value.replace(/([a-z0-9])([A-Z])/g, '$1 $2')).split(' ').filter(Boolean);
const tokens = (value: string) => [...new Set(orderedTerms(value))];
const symbolCounts = (value: string) => {
  const text = exactText(value);
  const symbols = [...text.matchAll(/[+#×÷−]/gu)].map((match) => match[0]);
  for (const _match of text.matchAll(/\.{3}/gu)) symbols.push('...');
  if (/(^|\s)-(?=\s|$)/u.test(text)) symbols.push('-');
  return symbols.reduce((counts, symbol) => counts.set(symbol, (counts.get(symbol) || 0) + 1), new Map<string, number>());
};
const spatialTerms = new Set(['left', 'right', 'top', 'bottom', 'center', 'middle']);
const grammarTerms = new Set([
  'a', 'an', 'and', 'or', 'the', 'this', 'that', 'these', 'those', 'please', 'can', 'could', 'would', 'you', 'me',
  'on', 'in', 'at', 'of', 'to', 'for', 'with', 'from', 'named', 'called', 'labeled', 'labelled',
  'title', 'caption', 'control', 'element', 'object', 'item', 'target'
]);
const actionTerms = new Set([
  'click', 'doubleclick', 'rightclick', 'press', 'tap', 'activate', 'invoke', 'focus', 'hover', 'move', 'drag', 'drop',
  'scroll', 'type', 'enter', 'set', 'toggle', 'select', 'choose', 'expand', 'collapse', 'open', 'close', 'find', 'locate', 'look', 'use'
]);
const labelActionTerms = new Set(['enter', 'set', 'toggle', 'select', 'choose', 'expand', 'collapse', 'open', 'close']);
const stateTerms = new Set(['current', 'active', 'focused', 'selected', 'visible']);
const commandTerms = (query: string) => {
  const ordered = orderedTerms(query);
  const start = ordered.findIndex((term) => !grammarTerms.has(term));
  const leading = new Set<string>();
  const removed = new Set<number>();
  const first = ordered[start];
  const second = ordered[start + 1];
  if (['left', 'right', 'middle', 'double'].includes(first) && second === 'click') {
    leading.add(first);
    leading.add(second);
    removed.add(start);
    removed.add(start + 1);
  } else if (actionTerms.has(first)) {
    leading.add(first);
    removed.add(start);
  }
  return { leading, remaining: ordered.filter((_term, index) => !removed.has(index)) };
};
const containsPhrase = (first: string, second: string) =>
  Math.min(first.length, second.length) >= 2
  && (` ${first} `.includes(` ${second} `) || ` ${second} `.includes(` ${first} `));
const positionScore = (query: string, element: ScreenElement, width: number, height: number) => {
  const x = element.safePoint.x / Math.max(1, width);
  const y = element.safePoint.y / Math.max(1, height);
  const content = new Set(tokens(`${element.name} ${element.value || ''}`));
  const queryTokens = new Set(commandTerms(query).remaining.filter((term) => !content.has(term)));
  const checks = [
    { word: 'left', matches: x <= 0.4 },
    { word: 'right', matches: x >= 0.6 },
    { word: 'top', matches: y <= 0.4 },
    { word: 'bottom', matches: y >= 0.6 },
    { word: 'middle', matches: y > 0.3 && y < 0.7 },
    { word: 'center', matches: x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7 }
  ];
  const requested = checks.filter((check) => queryTokens.has(check.word));
  return requested.length > 0 && requested.every((check) => check.matches) ? 0.14 : 0;
};
const scoreElement = (element: ScreenElement, query: string, width: number, height: number) => {
  const normalizedQuery = normalize(query);
  const queryTokens = tokens(query);
  const queryExact = exactText(query);
  const name = normalize(element.name);
  const value = normalize(element.value || '');
  const nameExact = exactText(element.name);
  const valueExact = exactText(element.value || '');
  const role = normalize(element.role);
  const searchable = new Set(tokens(`${name} ${value} ${element.role}`));
  const matchedTokens = queryTokens.filter((token) => searchable.has(token));
  const roleTerms = tokens(element.role);
  const roleRequested = queryTokens.includes(role) || roleTerms.length > 0 && roleTerms.every((term) => queryTokens.includes(term));
  const reasons: string[] = [];
  let score = element.confidence * 0.16;
  if (nameExact && nameExact === queryExact) { score += 0.62; reasons.push('exact name'); }
  else if (name && containsPhrase(name, normalizedQuery)) { score += 0.43; reasons.push('name phrase'); }
  if (valueExact && valueExact === queryExact) { score += 0.42; reasons.push('exact value'); }
  if (role && roleRequested) { score += 0.26; reasons.push('role'); }
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
const semanticGrounding = (
  element: ReturnType<typeof scoreElement>, exactQuery: string, queryTerms: string[], targetTerms: string[],
  requestedRoles: Set<string>, positionTerms: string[], requestedStates: string[], requestedSymbols: Map<string, number>
) => {
  const name = exactText(element.name);
  const value = exactText(element.value || '');
  const content = new Set(tokens(`${element.name} ${element.value || ''}`));
  if (name === exactQuery || value === exactQuery) return true;
  const roleGrounded = requestedRoles.size === 0 || requestedRoles.has(normalize(element.role));
  const positionGrounded = positionTerms.every((term) => content.has(term)) || element.reasons.includes('position');
  const stateContent = new Set(tokens(`${element.name} ${element.value || ''} ${element.evidence?.join(' ') || ''}`));
  const stateGrounded = requestedStates.every((term) => term === 'visible'
    ? !element.offscreen
    : term === 'focused' ? element.focused : stateContent.has(term));
  const contentSymbols = symbolCounts(`${element.name} ${element.value || ''}`);
  const symbolsGrounded = [...requestedSymbols].every(([symbol, count]) => (contentSymbols.get(symbol) || 0) >= count);
  if (!roleGrounded || !positionGrounded || !stateGrounded || !symbolsGrounded) return false;
  if (targetTerms.length > 0) return targetTerms.every((term) => content.has(term));
  const meaningful = new Set(['exact name', 'name phrase', 'exact value', 'role', 'position']);
  return requestedRoles.size > 0 || positionTerms.length > 0 || requestedStates.length > 0 || requestedSymbols.size > 0
    || queryTerms.length > 0 && element.reasons.some((reason) => meaningful.has(reason));
};
const compareMatches = (first: ReturnType<typeof scoreElement>, second: ReturnType<typeof scoreElement>) =>
  second.score - first.score || second.confidence - first.confidence || first.id.localeCompare(second.id);
const roleVariants = (elements: ScreenElement[]) => {
  const roleNames = new Map(elements.filter((element) => normalize(element.role)).map((element) => [normalize(element.role), element.role]));
  return [...roleNames].map(([key, name]) => ({ key, name, terms: tokens(name) }));
};

const requestedRolesFor = (roles: ReturnType<typeof roleVariants>, queryTerms: string[]) => {
  const matchedRoles = roles.filter((role) => queryTerms.includes(role.key)
    || role.terms.length > 0 && role.terms.every((term) => queryTerms.includes(term)));
  return matchedRoles.filter((role) => !matchedRoles.some((other) =>
    other.key !== role.key && other.terms.length > role.terms.length && role.terms.every((term) => other.terms.includes(term))));
};

const deterministicMatchesSingle = (elements: ScreenElement[], query: string, width: number, height: number, roles: ReturnType<typeof roleVariants>) => {
  const exactQuery = exactText(query);
  const queryTerms = tokens(query);
  if (!exactQuery) return [];
  const specificRoles = requestedRolesFor(roles, queryTerms);
  const requestedRoles = new Set(specificRoles
    .map((role) => role.key));
  const requestedRoleTerms = new Set(roles.filter((role) => requestedRoles.has(role.key)).flatMap((role) => [role.key, ...role.terms]));
  const command = commandTerms(query);
  const positionTerms = [...new Set(command.remaining.filter((term) => spatialTerms.has(term)))];
  const requestedStates = queryTerms.filter((term) => stateTerms.has(term));
  const preliminaryTargets = queryTerms.filter((term) => !grammarTerms.has(term) && !positionTerms.includes(term)
    && !requestedRoleTerms.has(term) && !stateTerms.has(term));
  const nonActionTargets = preliminaryTargets.filter((term) => !command.leading.has(term));
  const requestedSymbols = symbolCounts(query);
  const structural = requestedRoles.size > 0 || positionTerms.length > 0 || requestedStates.length > 0 || requestedSymbols.size > 0;
  const labelCarrier = [...requestedRoles].some((role) => role === 'button' || role === 'menuitem');
  const labelAction = requestedStates.length === 0 && labelCarrier && [...command.leading].some((term) => labelActionTerms.has(term));
  const targetTerms = nonActionTargets.length > 0 ? nonActionTargets : structural && !labelAction ? [] : preliminaryTargets;
  return elements.map((element) => scoreElement(element, query, width, height))
    .filter((element) => element.score >= 0.14 && semanticGrounding(
      element, exactQuery, queryTerms, targetTerms, requestedRoles, positionTerms, requestedStates, requestedSymbols))
    .sort(compareMatches);
};

const sharedContext = (entries: string[][]) => {
  const present = entries.filter((entry) => entry.length > 0);
  return new Set(present.map((entry) => [...entry].sort().join(' '))).size === 1 ? present[0] : undefined;
};

const contextualAlternatives = (values: string[], roles: ReturnType<typeof roleVariants>) => {
  const contexts = values.map((value) => ({
    value,
    roles: requestedRolesFor(roles, tokens(value)).map((role) => role.key),
    states: tokens(value).filter((term) => stateTerms.has(term)),
    positions: commandTerms(value).remaining.filter((term) => spatialTerms.has(term))
  }));
  const knownRoles = new Set(contexts.flatMap((context) => context.roles));
  const sharedStates = sharedContext(contexts.map((context) => context.states));
  const sharedPositions = sharedContext(contexts.map((context) => context.positions));
  return contexts.flatMap((context) => {
    const additions: string[] = [];
    if (context.roles.length === 0 && knownRoles.size > 1) return [];
    if (context.roles.length === 0 && knownRoles.size === 1) additions.push(roles.find((role) => knownRoles.has(role.key))!.name);
    if (context.states.length === 0 && contexts.some((entry) => entry.states.length > 0) && !sharedStates) return [];
    if (context.positions.length === 0 && contexts.some((entry) => entry.positions.length > 0) && !sharedPositions) return [];
    if (context.states.length === 0 && sharedStates) additions.push(...sharedStates);
    if (context.positions.length === 0 && sharedPositions) additions.push(...sharedPositions);
    return [`${context.value} ${additions.join(' ')}`.trim()];
  });
};

const deterministicMatches = (elements: ScreenElement[], query: string, width: number, height: number) => {
  const roles = roleVariants(elements);
  const alternatives = query.normalize('NFKC').split(/\s+or\s+/iu).map((value) => value.trim()).filter(Boolean);
  const queries = alternatives.length > 1 ? [query, ...contextualAlternatives(alternatives, roles)] : [query];
  const byId = new Map<string, ReturnType<typeof scoreElement>>();
  for (const match of queries.flatMap((value) => deterministicMatchesSingle(elements, value, width, height, roles))) {
    const existing = byId.get(match.id);
    if (!existing || compareMatches(match, existing) < 0) byId.set(match.id, match);
  }
  return [...byId.values()].sort(compareMatches);
};

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
  elements: ScreenElement[], ranked: ReturnType<typeof deterministicMatches>, query: string, width: number, height: number
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
  config: ServerConfig; observationId: string; query: string; elements: ScreenElement[];
  image: Buffer; mimeType: string; width: number; height: number;
  limit?: number; useVision?: boolean;
}): Promise<GroundingResult> => {
  const ranked = deterministicMatches(params.elements, params.query, params.width, params.height);
  const limit = Math.max(1, Math.min(50, params.limit || 10));
  if (!exactText(params.query)) return {
    observationId: params.observationId,
    query: params.query,
    matches: [],
    usedVision: false,
    warning: 'Locate query contains no searchable terms.'
  };
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
    overlay = await renderSetOfMark(params.image, candidates, params.width, params.height, candidates.length, params.config.screenshotMaxBytes);
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
  const rankedIds = new Set(ranked.map((candidate) => candidate.id));
  const selected = vision.ids.map((id) => byId.get(id))
    .filter((candidate): candidate is GroundingResult['matches'][number] => Boolean(candidate))
    .map((candidate) => rankedIds.has(candidate.id)
      ? candidate
      : { ...candidate, score: Math.min(0.51, candidate.score), reasons: [...candidate.reasons, 'vision rank without deterministic corroboration'] });
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  const matches = [...selected, ...ranked.filter((candidate) => !selectedIds.has(candidate.id))].slice(0, limit).map((match) => selectedIds.has(match.id) ? {
    ...match,
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
