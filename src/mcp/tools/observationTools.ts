import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import sharp from 'sharp';
import { z } from 'zod';
import { compactObservation, imageToScreenBounds, requireElement, requireObservation } from '../../actions/observations';
import { createObservation } from '../../observation/create';
import { withPerceptionDeadline } from '../../perception/deadline';
import { createObservationOverlay, locateObservation } from '../../observation/locate';
import { locateEvidenceReasons, selectDiverseElements, selectEvidenceElements } from '../../observation/presentation';
import { storeImageResource } from '../../observation/resources';
import { waitForObservation } from '../../observation/wait';
import type { Observation } from '../../types/perception';
import type { RuntimeState } from '../../types/runtime';
import { resourceReference } from '../../runtime/resources';
import { getWindow } from '../../windows/windows';
import { runTool, toolError, toolResult } from '../toolResult';

const boundsSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number()
});

const sameBounds = (first: z.infer<typeof boundsSchema>, second: z.infer<typeof boundsSchema>) =>
  first.left === second.left && first.top === second.top && first.right === second.right && first.bottom === second.bottom;

const observeSchema = z.object({
  target: z.enum(['foreground', 'window', 'region', 'desktop']).default('foreground'),
  windowHandle: z.string().optional(),
  bounds: boundsSchema.optional(),
  mode: z.enum(['fast', 'standard', 'deep']).default('standard'),
  includeCursor: z.boolean().default(false),
  includeOverlay: z.boolean().optional(),
  inlineImage: z.boolean().optional(),
  elementLimit: z.number().int().min(0).max(500).default(80),
  regionObservationId: z.string().optional(),
  regionToken: z.string().optional(),
  regionElementId: z.string().optional(),
  regionPadding: z.number().int().min(0).max(200).default(24)
});

const locateSchema = z.object({
  observationId: z.string().min(1),
  query: z.string(),
  limit: z.number().int().min(1).max(50).default(10),
  useVision: z.boolean().default(false)
});

const inspectSchema = z.object({
  observationId: z.string().min(1),
  elementId: z.string().min(1),
  includeCrop: z.boolean().default(true),
  padding: z.number().int().min(0).max(100).default(12)
});

const overlaySchema = z.object({
  observationId: z.string().min(1),
  elementIds: z.array(z.string()).max(200).optional(),
  inlineImage: z.boolean().default(false)
});

const waitSchema = z.object({
  condition: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('visualChange'), minimumRatio: z.number().min(0).max(1).optional() }),
    z.object({ kind: z.literal('queryAppears'), query: z.string().min(1), minimumScore: z.number().min(0).max(1.5).optional(), useVision: z.boolean().optional() }),
    z.object({ kind: z.literal('queryDisappears'), query: z.string().min(1), minimumScore: z.number().min(0).max(1.5).optional(), useVision: z.boolean().optional() })
  ]),
  target: z.enum(['foreground', 'window', 'region', 'desktop']).default('foreground'),
  windowHandle: z.string().optional(),
  bounds: boundsSchema.optional(),
  timeoutMs: z.number().int().min(100).max(120000).default(15000),
  intervalMs: z.number().int().min(100).max(5000).default(500)
});

const observationValue = (observation: Awaited<ReturnType<typeof createObservation>>, elements: Observation['elements']) => ({
  ...compactObservation(observation),
  screenshotUri: observation.screenshotUri,
  sceneUri: observation.sceneUri,
  overlayUri: observation.overlayUri,
  captureBackend: observation.captureBackend,
  changeRatio: observation.changeRatio,
  stageMs: observation.stageMs,
  elements,
  returnedElementCount: elements.length,
  elementSelection: 'priority_source_spatial'
});

const observeResult = async (
  state: RuntimeState,
  observation: Awaited<ReturnType<typeof createObservation>>,
  limit: number,
  inline: boolean,
  overlay: boolean
): Promise<CallToolResult> => {
  const elements = selectDiverseElements(observation.elements, limit, observation.width, observation.height);
  const screenshot = state.screenshots.get(observation.screenshotId);
  let overlayResource: Awaited<ReturnType<typeof createObservationOverlay>> | undefined;
  let warning: string | undefined;
  if (inline && overlay) {
    try {
      overlayResource = await createObservationOverlay(state, observation.id, elements.map((element) => element.id));
      observation.overlayUri = overlayResource.uri;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      warning = `Inline Set-of-Mark rendering failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const image = overlayResource?.bytes ? overlayResource : screenshot;
  const value = {
    ...observationValue(observation, elements),
    visualEvidence: {
      included: Boolean(inline && image),
      kind: overlayResource ? 'set_of_mark' : inline && screenshot ? 'screenshot' : 'none',
      resource: overlayResource ? resourceReference(overlayResource) : undefined,
      warning
    }
  };
  const result = toolResult(value);
  if (inline && image?.bytes) result.content.push({ type: 'image', data: image.bytes.toString('base64'), mimeType: image.mimeType });
  return result;
};

const visionStatus = (requested: boolean, configured: boolean, used: boolean) =>
  used ? 'used' : !requested ? 'not_requested' : !configured ? 'not_configured' : 'requested_but_not_used';

const locateResult = async (state: RuntimeState, observationId: string, query: string, limit: number, useVision: boolean, signal?: AbortSignal) => {
  try {
    return await withPerceptionDeadline(Date.now() + state.config.visionTimeoutMs + 10_000, async () => {
      const located = await locateObservation(state, observationId, query, { limit, useVision });
      const configured = Boolean(state.config.visionApiUrl && state.config.visionModel);
      const reasons = locateEvidenceReasons(located.matches);
      const observation = requireObservation(state, observationId);
      let resource: Awaited<ReturnType<typeof createObservationOverlay>> | undefined;
      let warning: string | undefined;
      if (reasons.length) {
        const elements = selectEvidenceElements(observation.elements, located.matches, 64, observation.width, observation.height);
        try {
          resource = await createObservationOverlay(state, observationId, elements.map((element) => element.id));
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          warning = `Automatic Set-of-Mark rendering failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const value = {
        ...located,
        serverVision: {
          requested: useVision,
          configured,
          used: located.usedVision,
          status: visionStatus(useVision, configured, located.usedVision),
          warning: located.warning
        },
        visualEvidence: {
          included: Boolean(resource?.bytes),
          kind: resource ? 'set_of_mark' : 'none',
          reasons,
          resource: resource ? resourceReference(resource) : undefined,
          warning
        }
      };
      const result = toolResult(value);
      if (resource?.bytes) result.content.push({ type: 'image', data: resource.bytes.toString('base64'), mimeType: resource.mimeType });
      return result;
    }, signal);
  } catch (error) {
    return toolError(error);
  }
};

const cropElement = async (state: RuntimeState, observation: Observation, elementId: string, padding: number, signal?: AbortSignal) => {
  const element = requireElement(observation, elementId);
  const screenshot = state.screenshots.get(observation.screenshotId);
  if (!screenshot) throw new Error('Observation screenshot expired.');
  const left = Math.max(0, Math.floor(element.bounds.left - padding));
  const top = Math.max(0, Math.floor(element.bounds.top - padding));
  const right = Math.min(screenshot.width, Math.ceil(element.bounds.right + padding));
  const bottom = Math.min(screenshot.height, Math.ceil(element.bounds.bottom + padding));
  const bytes = await sharp(screenshot.bytes).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
  if (signal?.aborted) throw signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('Element inspection was cancelled.'), { name: 'AbortError' });
  if (state.closing) throw Object.assign(new Error('Runtime is shutting down.'), { name: 'AbortError' });
  return storeImageResource(state, `crop-${observation.id}-${element.id}.png`, 'image/png', bytes, 'crops');
};

const registerObserve = (server: McpServer, state: RuntimeState) => server.registerTool('computer_observe', {
  title: 'Observe Windows screen',
  description: 'Capture a target and return a priority/source/spatially diverse set of snapshot-scoped UI Automation, OCR, and OpenCV elements. Deep mode includes inline Set-of-Mark evidence unless inlineImage is false.',
  inputSchema: observeSchema,
  annotations: { readOnlyHint: true }
}, async ({ target, windowHandle, bounds, mode, includeCursor, includeOverlay, inlineImage, elementLimit, regionObservationId, regionToken, regionElementId, regionPadding }, extra) => {
  try {
    const inline = inlineImage ?? mode === 'deep';
    const overlay = includeOverlay ?? mode === 'deep';
    const profile = mode === 'fast'
      ? { deadlineMs: 10_000, maxAccessibilityNodes: 400, accessibilityTimeoutMs: 5_000 }
      : mode === 'standard' ? { deadlineMs: 60_000, maxAccessibilityNodes: 1_200, accessibilityTimeoutMs: 12_000 }
        : { deadlineMs: 120_000, maxAccessibilityNodes: state.config.maxElements * 4, accessibilityTimeoutMs: 20_000 };
    const source = regionElementId
      ? requireObservation(state, regionObservationId || '', regionToken || '')
      : undefined;
    const sourceElement = source && regionElementId ? requireElement(source, regionElementId) : undefined;
    const currentWindow = source?.window ? await getWindow(source.window.handle, extra.signal) : undefined;
    if (source?.window && (!currentWindow || !sameBounds(currentWindow.bounds, source.window.bounds))) {
      throw new Error('Region source window moved, resized, or closed. Capture a new observation.');
    }
    const regionBounds = source && sourceElement ? imageToScreenBounds(source, {
      left: Math.max(0, sourceElement.bounds.left - regionPadding),
      top: Math.max(0, sourceElement.bounds.top - regionPadding),
      right: Math.min(source.width, sourceElement.bounds.right + regionPadding),
      bottom: Math.min(source.height, sourceElement.bounds.bottom + regionPadding)
    }) : bounds;
    return await withPerceptionDeadline(Date.now() + profile.deadlineMs, async () => {
      const observation = await createObservation(state, {
        target: source ? 'region' : target,
        windowHandle: source?.window?.handle || windowHandle,
        bounds: regionBounds,
        analysisLevel: mode,
        maxAccessibilityNodes: profile.maxAccessibilityNodes,
        accessibilityTimeoutMs: profile.accessibilityTimeoutMs,
        includeCursor,
        includeAccessibility: true,
        includeOcr: mode !== 'fast',
        includeOpenCv: mode !== 'fast',
        includeOverlay: overlay && !inline
      });
      return await observeResult(state, observation, elementLimit, inline, overlay);
    }, extra.signal);
  } catch (error) {
    return toolError(error);
  }
});

const registerLocate = (server: McpServer, state: RuntimeState) => server.registerTool('computer_locate', {
  title: 'Locate screen elements',
  description: 'Rank grounded elements by text, role, position, and optional configured server vision. Reports requested/configured/used vision state and automatically includes inline Set-of-Mark evidence for absent, ambiguous, weak, or OpenCV-only matches.',
  inputSchema: locateSchema,
  annotations: { readOnlyHint: true }
}, ({ observationId, query, limit, useVision }, extra) => locateResult(state, observationId, query, limit, useVision, extra.signal));

const registerInspect = (server: McpServer, state: RuntimeState) => server.registerTool('computer_inspect', {
  title: 'Inspect grounded element',
  description: 'Return complete evidence for one element and optionally a tightly bounded crop resource.',
  inputSchema: inspectSchema,
  annotations: { readOnlyHint: true }
}, ({ observationId, elementId, includeCrop, padding }, extra) => runTool(async () => {
  const observation = requireObservation(state, observationId);
  const element = requireElement(observation, elementId);
  const crop = includeCrop ? await cropElement(state, observation, elementId, padding, extra.signal) : undefined;
  return { observationId, element, crop: crop ? resourceReference(crop) : undefined };
}));

const registerOverlay = (server: McpServer, state: RuntimeState) => server.registerTool('computer_overlay', {
  title: 'Set-of-Mark overlay',
  description: 'Render grounded element identifiers over a snapshot for compact visual disambiguation.',
  inputSchema: overlaySchema,
  annotations: { readOnlyHint: true }
}, async ({ observationId, elementIds, inlineImage }, extra) => {
  try {
    const resource = await withPerceptionDeadline(Date.now() + 30_000, () => createObservationOverlay(state, observationId, elementIds), extra.signal);
    const value = { observationId, resource: resourceReference(resource) };
    const result = toolResult(value);
    if (inlineImage && resource.bytes) result.content.push({ type: 'image', data: resource.bytes.toString('base64'), mimeType: resource.mimeType });
    return result;
  } catch (error) {
    return toolError(error);
  }
});

const registerWait = (server: McpServer, state: RuntimeState) => server.registerTool('computer_wait', {
  title: 'Wait for screen state',
  description: 'Poll a target until pixels change or a grounded query appears or disappears, with bounded timeout.',
  inputSchema: waitSchema,
  annotations: { readOnlyHint: true }
}, ({ condition, target, windowHandle, bounds, timeoutMs, intervalMs }, extra) => runTool(async () => {
  const result = await waitForObservation(state, condition, { target, windowHandle, bounds }, { timeoutMs, intervalMs, signal: extra.signal });
  return {
    satisfied: result.satisfied,
    condition: result.condition,
    elapsedMs: result.elapsedMs,
    attempts: result.attempts,
    observation: result.observation ? {
      ...compactObservation(result.observation),
      screenshotUri: result.observation.screenshotUri,
      sceneUri: result.observation.sceneUri
    } : undefined,
    matches: result.matches
  };
}));

export const registerObservationTools = (server: McpServer, state: RuntimeState) => {
  registerObserve(server, state);
  registerLocate(server, state);
  registerInspect(server, state);
  registerOverlay(server, state);
  registerWait(server, state);
};
