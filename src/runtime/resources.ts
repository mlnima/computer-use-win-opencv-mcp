import type { RuntimeState, StoredResource } from '../types/runtime';
import { newId } from './state';

const resourceSize = (resource: StoredResource) => resource.bytes?.byteLength || Buffer.byteLength(resource.text || '');

const removeResource = (state: RuntimeState, id: string) => {
  state.resources.delete(id);
  if (!state.screenshots.delete(id)) return;
  const observationIds = [...state.observations.values()].filter((value) => value.screenshotId === id).map((value) => value.id);
  for (const observationId of observationIds) state.observations.delete(observationId);
  for (const [prepareId, prepared] of state.preparedPointers) {
    if (observationIds.includes(prepared.observationId)) state.preparedPointers.delete(prepareId);
  }
};

const pruneResources = (state: RuntimeState) => {
  const now = Date.now();
  for (const [id, resource] of state.resources) if (resource.expiresAt <= now) removeResource(state, id);
  let bytes = [...state.resources.values()].reduce((total, resource) => total + resourceSize(resource), 0);
  while (state.resources.size > state.config.resourceMaxItems || bytes > state.config.resourceMaxBytes) {
    const oldest = state.resources.entries().next().value as [string, StoredResource] | undefined;
    if (!oldest) break;
    removeResource(state, oldest[0]);
    bytes -= resourceSize(oldest[1]);
  }
};

export const addResource = (
  state: RuntimeState,
  input: { name: string; mimeType: string; bytes?: Buffer; text?: string; category?: string }
): StoredResource => {
  const size = input.bytes?.byteLength || Buffer.byteLength(input.text || '');
  if (size > state.config.resourceMaxBytes) throw new Error('Resource exceeds COMPUTER_USE_RESOURCE_MAX_BYTES.');
  const id = newId('resource');
  const createdAt = Date.now();
  const resource = {
    id,
    uri: `computer-use-win-opencv://resource/${input.category || 'data'}/${id}`,
    name: input.name,
    mimeType: input.mimeType,
    bytes: input.bytes,
    text: input.text,
    createdAt,
    expiresAt: createdAt + state.config.resourceTtlMs
  };
  state.resources.set(id, resource);
  pruneResources(state);
  if (!state.resources.has(id)) throw new Error('Resource could not be retained within the configured storage limits.');
  return resource;
};

export const findResource = (state: RuntimeState, uriOrId: string) => {
  const id = uriOrId.includes('/') ? uriOrId.split('/').at(-1) || '' : uriOrId;
  const resource = state.resources.get(id);
  if (resource && resource.expiresAt <= Date.now()) {
    removeResource(state, id);
    return undefined;
  }
  return resource;
};

export const touchResource = (state: RuntimeState, resource: StoredResource) => {
  resource.expiresAt = Date.now() + state.config.resourceTtlMs;
  state.resources.delete(resource.id);
  state.resources.set(resource.id, resource);
  return resource;
};

export const resourceReference = (resource: StoredResource) => ({
  id: resource.id,
  uri: resource.uri,
  name: resource.name,
  mimeType: resource.mimeType,
  size: resource.bytes?.byteLength || Buffer.byteLength(resource.text || '')
});
