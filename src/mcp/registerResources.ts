import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RuntimeState } from '../types/runtime';
import { findResource, touchResource } from '../runtime/resources';

export const registerResources = (server: McpServer, state: RuntimeState) => {
  const template = new ResourceTemplate('computer-use-win-opencv://resource/{category}/{id}', { list: undefined });
  server.registerResource('computer-resource', template, {
    title: 'Computer-use resource',
    description: 'Authenticated screenshots, overlays, traces, terminal output, and file content.',
    mimeType: 'application/octet-stream'
  }, async (uri) => {
    const resource = findResource(state, uri.toString());
    if (!resource || resource.expiresAt <= Date.now()) throw new Error('Resource was not found or expired.');
    touchResource(state, resource);
    return {
      contents: [{
        uri: resource.uri,
        name: resource.name,
        mimeType: resource.mimeType,
        ...(resource.bytes ? { blob: resource.bytes.toString('base64') } : { text: resource.text || '' })
      }]
    };
  });
};
