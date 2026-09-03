import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IPty } from '@lydell/node-pty';
import type { ServerConfig } from '../config';
import type { DragState, PreparedPointer } from './input';
import type { Observation, ScreenshotRecord } from './perception';

export type StoredResource = {
  id: string;
  uri: string;
  name: string;
  mimeType: string;
  bytes?: Buffer;
  text?: string;
  createdAt: number;
  expiresAt: number;
};

export type TerminalSession = {
  id: string;
  pty: IPty;
  output: string;
  baseOffset: number;
  cursor: number;
  createdAt: number;
  lastUsedAt: number;
};

export type TraceEvent = {
  id: string;
  at: string;
  kind: string;
  data: Record<string, unknown>;
};

export type RuntimeState = {
  config: ServerConfig;
  observations: Map<string, Observation>;
  screenshots: Map<string, ScreenshotRecord>;
  resources: Map<string, StoredResource>;
  preparedPointers: Map<string, PreparedPointer>;
  terminals: Map<string, TerminalSession>;
  trace: TraceEvent[];
  drag?: DragState;
  inputWorker?: ChildProcessWithoutNullStreams;
  inputQueue: Promise<unknown>;
  stateSweepTimer?: NodeJS.Timeout;
  control: {
    paused: boolean;
    emergencyStopped: boolean;
    epoch: number;
    lease?: { id: string; owner?: string; clientId: string; expiresAt: string };
    leaseTimer?: NodeJS.Timeout;
    cleanup?: Promise<void>;
    cleanupError?: string;
    cleanupRetryTimer?: NodeJS.Timeout;
    cleanupRetryCount?: number;
    cleanupGeneration?: number;
  };
  closing: boolean;
};
