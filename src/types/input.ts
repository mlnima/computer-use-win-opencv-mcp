import type { Bounds, Point } from './geometry';

export type MouseButton = 'left' | 'right' | 'middle' | 'x1' | 'x2';

export type KeyMode = 'press' | 'down' | 'up';

export type TimelineEvent =
  | { at: number; type: 'move'; x: number; y: number; duration?: number; relative?: boolean }
  | { at: number; type: 'button'; button: MouseButton; mode: KeyMode }
  | { at: number; type: 'key'; key: string; mode: KeyMode }
  | { at: number; type: 'text'; text: string }
  | { at: number; type: 'wheel'; deltaX?: number; deltaY?: number };

export type PreparedPointer = {
  id: string;
  clientId: string;
  leaseId: string;
  observationId: string;
  target: Point;
  elementId?: string;
  windowHandle?: string;
  preparedAt: string;
  expiresAt: string;
  imageHash: string;
  verification: 'geometry' | 'visual' | 'none';
  windowBounds?: Bounds;
  elementScreenBounds?: Bounds;
  uiaRuntimeId?: string;
  uiaClickablePoint?: boolean;
  visualBounds?: Bounds;
  visualSample?: Buffer;
};

export type DragState = {
  id: string;
  button: MouseButton;
  startedAt: string;
  point: Point;
  clientId?: string;
  leaseId?: string;
  destinationWindowHandle?: string;
  destinationWindowBounds?: Bounds;
  destinationUiaRuntimeId?: string;
  destinationElementBounds?: Bounds;
  destinationVisualBounds?: Bounds;
  destinationVisualSample?: Buffer;
};

export type InputResult = {
  ok: boolean;
  cursor: Point;
  durationMs: number;
  verification?: {
    windowHandle?: string;
    imageChanged?: boolean;
    targetStillValid?: boolean;
  };
};
