import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeState } from '../types/runtime';

const serialize = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);

const structuredValue = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { value };

export const toolResult = (value: unknown, summary?: string): CallToolResult => ({
  content: [{ type: 'text', text: `${summary ? `${summary}\n` : ''}${serialize(value)}` }],
  structuredContent: structuredValue(value)
});

export const toolError = (error: unknown): CallToolResult => ({
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  ...(error instanceof Error && 'recovery' in error ? { structuredContent: { error: error.message, code: (error as Error & { code?: string }).code, recovery: error.recovery } } : {}),
  isError: true
});

export const runTool = async (operation: () => Promise<unknown> | unknown, state?: RuntimeState): Promise<CallToolResult> => {
  try {
    const value = await operation();
    const result = toolResult(value);
    const evidence = value as { post?: { screenshotId?: string; inlineImage?: boolean }; hover?: { screenshotId?: string; inlineImage?: boolean } } | undefined;
    const screenshotId = evidence?.post?.screenshotId || evidence?.hover?.screenshotId;
    const inlineImage = evidence?.post?.screenshotId ? evidence.post.inlineImage : evidence?.hover?.inlineImage;
    const screenshot = screenshotId && inlineImage !== false ? state?.screenshots.get(screenshotId) : undefined;
    if (screenshot) result.content.push({ type: 'image', data: screenshot.bytes.toString('base64'), mimeType: screenshot.mimeType });
    return result;
  } catch (error) {
    return toolError(error);
  }
};
