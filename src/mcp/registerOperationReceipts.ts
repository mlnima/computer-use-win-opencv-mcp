import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RuntimeState } from '../types/runtime';
import { readOperationReceipt, runReceiptedOperation, acknowledgeOperationReceipt } from '../runtime/operationReceipts';
import { runTool, toolError, toolResult } from './toolResult';

export const registerOperationReceipts = (server: McpServer, state: RuntimeState) => {
  server.registerTool('computer_operation_status', {
    description: 'Recover a durable operation result after a lost response. An unknown outcome must be verified in the application before a new action.',
    inputSchema: { operationId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true },
  }, async ({ operationId }) => {
    try {
      const receipt = await readOperationReceipt(state, operationId);
      return receipt.result
        ? { ...receipt.result, _meta: { ...receipt.result._meta, 'io.eskai/receiptState': 'completed' } }
        : toolResult({ state: receipt.state });
    } catch (error) { return toolError(error); }
  });
  server.registerTool('computer_operation_acknowledge', {
    description: 'Release the stored response after the caller has durably saved it. The operation identifier remains reserved and cannot execute again.',
    inputSchema: { operationId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, ({ operationId }) => runTool(() => acknowledgeOperationReceipt(state, operationId)));
  const register = server.registerTool.bind(server);
  server.registerTool = ((name, config, callback) => {
    if (!config.inputSchema || config.annotations?.readOnlyHint || name === 'computer_control') return register(name, config, callback);
    const handler = callback as (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<CallToolResult>;
    return register(name, config, (async (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      const operationId = extra._meta?.['io.eskai/operationId'];
      if (typeof operationId !== 'string' || !operationId || operationId.length > 200) return handler(args, extra);
      try {
        extra.signal.throwIfAborted();
        return await runReceiptedOperation(state, operationId, name, args, () => handler(args, extra));
      } catch (error) { return { ...toolError(error), _meta: { 'io.eskai/outcome': 'unknown' } }; }
    }) as typeof callback);
  }) as typeof server.registerTool;
};
