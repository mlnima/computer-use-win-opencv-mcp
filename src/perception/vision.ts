import type { ServerConfig } from '../config';
import type { ScreenElement } from '../types/perception';
import { currentPerceptionDeadline, currentPerceptionSignal } from './deadline';

type VisionResult = {
  ids: string[];
  used: boolean;
  warning?: string;
};

const responseText = (payload: unknown) => {
  const value = payload as {
    ids?: unknown;
    output_text?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    result?: unknown;
  };
  if (Array.isArray(value.ids)) return JSON.stringify({ ids: value.ids });
  if (typeof value.output_text === 'string') return value.output_text;
  if (typeof value.choices?.[0]?.message?.content === 'string') return value.choices[0].message.content;
  return typeof value.result === 'string' ? value.result : JSON.stringify(value.result || value);
};

const parseIds = (text: string, allowed: Set<string>) => {
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  const json = objectStart >= 0 && objectEnd > objectStart
    ? text.slice(objectStart, objectEnd + 1)
    : arrayStart >= 0 && arrayEnd > arrayStart ? text.slice(arrayStart, arrayEnd + 1) : text;
  const parsed = JSON.parse(json) as { ids?: unknown } | unknown[];
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.ids) ? parsed.ids : [];
  const ids = [...new Set(entries.map((entry) => typeof entry === 'string' ? entry : String((entry as { id?: unknown })?.id || '')).filter((id) => allowed.has(id)))];
  return { ids, valid: Array.isArray(parsed) || Array.isArray(parsed.ids), supplied: entries.length };
};

export const rankWithVision = async (
  config: ServerConfig,
  query: string,
  image: Buffer,
  mimeType: string,
  candidates: ScreenElement[]
): Promise<VisionResult> => {
  if (!config.visionApiUrl || !config.visionModel || candidates.length === 0) return { ids: [], used: false };
  const deadlineAt = currentPerceptionDeadline();
  const timeoutMs = deadlineAt === undefined ? config.visionTimeoutMs : Math.min(config.visionTimeoutMs, deadlineAt - Date.now());
  if (timeoutMs <= 0) return { ids: [], used: false, warning: 'Vision ranking unavailable: perception deadline elapsed.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = currentPerceptionSignal();
  const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const candidateData = candidates.slice(0, 100).map((candidate) => ({
    id: candidate.id,
    role: candidate.role,
    name: candidate.name,
    value: candidate.value,
    bounds: candidate.bounds,
    sources: candidate.sources,
    confidence: candidate.confidence,
    evidence: candidate.evidence
  }));
  try {
    const response = await fetch(config.visionApiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.visionApiKey ? { authorization: `Bearer ${config.visionApiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.visionModel,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Rank only the supplied element IDs for the requested screen target. Return strict JSON as {"ids":["e1"]}. Never invent an ID or return coordinates.' },
          { role: 'user', content: [
            { type: 'text', text: JSON.stringify({ query, candidates: candidateData }) },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image.toString('base64')}` } }
          ] }
        ]
      }),
      signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseIds(responseText(await response.json()), allowed);
    const valid = parsed.valid && (parsed.supplied === 0 || parsed.ids.length > 0);
    return { ids: parsed.ids, used: valid, warning: valid ? undefined : 'Vision model returned no valid element IDs.' };
  } catch (error) {
    return { ids: [], used: false, warning: `Vision ranking unavailable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
};
