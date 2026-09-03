import { addResource, findResource } from '../runtime/resources';
import { cleanExpiredState } from '../runtime/state';
import type { RuntimeState } from '../types/runtime';

export const storeImageResource = (
  state: RuntimeState,
  name: string,
  mimeType: string,
  bytes: Buffer,
  category = 'images'
) => addResource(state, { name, mimeType, bytes, category });

export const storeTextResource = (
  state: RuntimeState,
  name: string,
  mimeType: string,
  text: string,
  category = 'data'
) => addResource(state, { name, mimeType, text, category });

export const readStoredResource = (state: RuntimeState, uriOrId: string) => {
  const resource = findResource(state, uriOrId);
  return resource && resource.expiresAt > Date.now() ? resource : undefined;
};

export const pruneObservationStorage = (state: RuntimeState) => cleanExpiredState(state);
