import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createObservation } from '../observation/create';
import type { Observation } from '../types/perception';
import type { RuntimeState } from '../types/runtime';
import { getWindow } from '../windows/windows';

export const locateSchema = z.object({
  observationId: z.string().min(1).optional().describe('Omit to refresh and search this client\'s latest observed target. Call computer_observe first if this client has no observation.'),
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  useVision: z.boolean().default(false)
});

export const registerObservationContext = (server: McpServer, state: RuntimeState) => {
  let latest: Pick<Observation, 'capturedAt' | 'target' | 'window' | 'bounds' | 'elementsAnalyzed' | 'analysis'> | undefined;
  const remember = (result: CallToolResult) => {
    const value = result.structuredContent as {
      id?: string; observationId?: string; screenshotId?: string; matches?: unknown[];
      post?: { id?: string }; observation?: { id?: string };
    } | undefined;
    const id = value?.post?.id || value?.observation?.id || (value?.screenshotId ? value.id : value?.matches ? value.observationId : undefined);
    const observation = !result.isError && id ? state.observations.get(id) : undefined;
    if (!observation || latest && Date.parse(observation.capturedAt) < Date.parse(latest.capturedAt)) return;
    const { capturedAt, target, window, bounds, elementsAnalyzed, analysis } = observation;
    latest = { capturedAt, target, window, bounds, elementsAnalyzed, analysis };
  };
  const register = server.registerTool.bind(server);
  server.registerTool = ((name, config, callback) => {
    if (!config.inputSchema) return register(name, config, callback);
    const handler = callback as (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<CallToolResult>;
    return register(name, config, (async (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      const result = await handler(args, extra);
      remember(result);
      return result;
    }) as typeof callback);
  }) as typeof server.registerTool;
  return async (observationId: string | undefined, signal?: AbortSignal) => {
    if (observationId !== undefined) return observationId;
    const source = latest;
    if (!source) throw new Error('This client has no current observation. Call computer_observe first or supply observationId.');
    if (source.window) {
      const current = await getWindow(source.window.handle, signal);
      if (!current || current.processId !== source.window.processId) throw new Error('The current observation window closed or was replaced. Call computer_observe to choose the current target.');
      if (source.target === 'region' && (Object.keys(current.bounds) as Array<keyof typeof current.bounds>)
        .some((key) => current.bounds[key] !== source.window!.bounds[key])) {
        throw new Error('The current observation region moved or resized. Call computer_observe to choose the current region.');
      }
    }
    const observation = await createObservation(state, {
      target: source.target,
      windowHandle: source.window?.handle,
      bounds: source.target === 'region' ? source.bounds : undefined,
      includeAccessibility: !source.elementsAnalyzed || source.analysis.accessibility,
      includeOcr: !source.elementsAnalyzed || source.analysis.ocr,
      includeOpenCv: !source.elementsAnalyzed || source.analysis.opencv,
      analysisLevel: source.analysis.level,
      maxAccessibilityNodes: source.analysis.level === 'fast' ? 400 : source.analysis.level === 'standard' ? 1_200 : state.config.maxElements * 4,
      accessibilityTimeoutMs: source.analysis.level === 'fast' ? 5_000 : source.analysis.level === 'standard' ? 15_000 : 20_000,
      signal
    });
    return observation.id;
  };
};
