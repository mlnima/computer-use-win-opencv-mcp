import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RuntimeState, TraceEvent } from '../types/runtime';
import type { ServerConfig } from '../config';

export const createRuntimeState = (config: ServerConfig): RuntimeState => {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const state: RuntimeState = {
    config,
    observations: new Map(),
    screenshots: new Map(),
    resources: new Map(),
    preparedPointers: new Map(),
    terminals: new Map(),
    trace: [],
    inputQueue: Promise.resolve(),
    control: { paused: false, emergencyStopped: false, epoch: 0 },
    closing: false
  };
  state.stateSweepTimer = setInterval(() => cleanExpiredState(state), Math.max(1000, Math.min(60_000, config.resourceTtlMs)));
  state.stateSweepTimer.unref();
  return state;
};

export const recordTrace = (state: RuntimeState, kind: string, data: Record<string, unknown> = {}): TraceEvent => {
  const event = { id: randomUUID(), at: new Date().toISOString(), kind, data };
  state.trace.push(event);
  if (state.trace.length > 1000) state.trace.splice(0, state.trace.length - 1000);
  return event;
};

export const cleanExpiredState = (state: RuntimeState) => {
  const now = Date.now();
  for (const [id, value] of state.resources) {
    if (value.expiresAt > now) continue;
    state.resources.delete(id);
    if (!state.screenshots.delete(id)) continue;
    const observationIds = [...state.observations.values()].filter((observation) => observation.screenshotId === id).map((observation) => observation.id);
    for (const observationId of observationIds) state.observations.delete(observationId);
    for (const [prepareId, prepared] of state.preparedPointers) {
      if (observationIds.includes(prepared.observationId)) state.preparedPointers.delete(prepareId);
    }
  }
  for (const [id, value] of state.observations) {
    if (Date.parse(value.expiresAt) > now) continue;
    state.observations.delete(id);
    for (const [prepareId, prepared] of state.preparedPointers) {
      if (prepared.observationId === id) state.preparedPointers.delete(prepareId);
    }
  }
  for (const [id, value] of state.preparedPointers) if (Date.parse(value.expiresAt) <= now) state.preparedPointers.delete(id);
  const referenced = new Set([...state.observations.values()].map((value) => value.screenshotId));
  for (const [id, value] of state.screenshots) {
    if (!referenced.has(id) && Date.parse(value.capturedAt) + state.config.resourceTtlMs <= now) state.screenshots.delete(id);
  }
  for (const [id, terminal] of state.terminals) {
    if (terminal.lastUsedAt + state.config.terminalIdleMs > now) continue;
    void terminal.close().catch(() => undefined);
    state.terminals.delete(id);
  }
};

export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
