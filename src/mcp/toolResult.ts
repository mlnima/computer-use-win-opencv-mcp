import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const serialize = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);

const structuredValue = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { value };

export const toolResult = (value: unknown, summary?: string): CallToolResult => ({
  content: [{ type: 'text', text: `${summary ? `${summary}\n` : ''}${serialize(value)}` }],
  structuredContent: structuredValue(value)
});

export const toolError = (error: unknown): CallToolResult => ({
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  isError: true
});

export const runTool = async (operation: () => Promise<unknown> | unknown): Promise<CallToolResult> => {
  try {
    return toolResult(await operation());
  } catch (error) {
    return toolError(error);
  }
};
