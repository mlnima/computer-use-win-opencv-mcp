import type { Point } from '../types/geometry';
import type { MouseButton } from '../types/input';

export type NativeProbe = Point & {
  windowHandle: string;
  screen: { left: number; top: number; width: number; height: number };
};

export type NativeCommand =
  | { op: 'probe' }
  | { op: 'moveAbsolute'; x: number; y: number }
  | { op: 'moveRelative'; x: number; y: number }
  | { op: 'button'; button: MouseButton; down: boolean }
  | { op: 'wheel'; deltaX: number; deltaY: number }
  | { op: 'virtualKey'; key: number; down: boolean; extended: boolean }
  | { op: 'scanCode'; scan: number; down: boolean; extended: boolean }
  | { op: 'mappedScanCode'; key: number; down: boolean; extended: boolean }
  | { op: 'text'; text: string }
  | { op: 'releaseAll' }
  | { op: 'close' };

export type WorkerResponse<T = unknown> = {
  id: string;
  ok: boolean;
  data?: T;
  error?: string;
};

export type WorkerClient = {
  command: <T>(command: NativeCommand, timeoutMs?: number) => Promise<T>;
  close: () => Promise<void>;
  terminate: (error: Error) => Promise<void>;
};
