export type TerminalCommandInput =
  | { action: 'create'; sessionId: string; shell: string; cwd: string; columns: number; rows: number }
  | { action: 'write'; sessionId: string; data: string }
  | { action: 'resize'; sessionId: string; columns: number; rows: number }
  | { action: 'close'; sessionId: string }
  | { action: 'shutdown' };

export type TerminalCommand = TerminalCommandInput & { id: string };

export type TerminalWorkerMessage =
  | { type: 'ready' }
  | { type: 'response'; id: string; ok: true; data: Record<string, unknown> }
  | { type: 'response'; id: string; ok: false; error: string }
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; exitCode: number }
  | { type: 'fatal'; error: string };

export type TerminalListener = {
  data: (value: string) => void;
  exit: (error?: Error) => void;
};

export type TerminalWorkerClient = {
  command: <T extends Record<string, unknown>>(value: TerminalCommandInput, timeoutMs?: number) => Promise<T>;
  attach: (sessionId: string, listener: TerminalListener) => () => void;
  close: () => Promise<void>;
};
