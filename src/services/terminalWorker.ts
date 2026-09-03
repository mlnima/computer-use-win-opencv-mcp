import process from 'node:process';
import readline from 'node:readline';
import * as pty from '@lydell/node-pty';
import type { TerminalCommand, TerminalWorkerMessage } from './terminalProtocol';

const terminals = new Map<string, pty.IPty>();
let failing = false;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const send = (message: TerminalWorkerMessage) => {
  if (!process.stdout.writable) return false;
  return process.stdout.write(`${JSON.stringify(message)}\n`);
};

const response = (id: string, data: Record<string, unknown>) => send({ type: 'response', id, ok: true, data });
const failure = (id: string, error: unknown) => send({ type: 'response', id, ok: false, error: errorText(error) });

const createTerminal = (command: Extract<TerminalCommand, { action: 'create' }>) => {
  const terminal = pty.spawn(command.shell, [], {
    name: 'xterm-256color',
    cols: command.columns,
    rows: command.rows,
    cwd: command.cwd,
    env: { ...process.env, TERM: 'xterm-256color' }
  });
  terminals.set(command.sessionId, terminal);
  let settled = false;
  const finish = () => {
    if (settled || terminal.pid <= 0) return;
    settled = true;
    clearInterval(readyPoll);
    clearTimeout(startupTimeout);
    response(command.id, { processId: terminal.pid });
  };
  terminal.onData((data) => {
    if (!send({ type: 'data', sessionId: command.sessionId, data })) terminal.pause();
    finish();
  });
  terminal.onExit(({ exitCode }) => {
    terminals.delete(command.sessionId);
    clearInterval(readyPoll);
    clearTimeout(startupTimeout);
    if (!settled) failure(command.id, new Error(`Terminal exited during startup with code ${exitCode}.`));
    send({ type: 'exit', sessionId: command.sessionId, exitCode });
  });
  const readyPoll = setInterval(finish, 10);
  const startupTimeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    clearInterval(readyPoll);
    terminals.delete(command.sessionId);
    try { terminal.kill(); } catch {}
    failure(command.id, new Error('Terminal process did not become ready within 5 seconds.'));
  }, 5_000);
};

const getTerminal = (sessionId: string) => {
  const terminal = terminals.get(sessionId);
  if (!terminal) throw new Error(`Terminal session not found: ${sessionId}`);
  return terminal;
};

const closeAll = () => {
  for (const terminal of terminals.values()) try { terminal.kill(); } catch {}
  terminals.clear();
};

const handle = (command: TerminalCommand) => {
  try {
    if (command.action === 'create') return createTerminal(command);
    if (command.action === 'shutdown') {
      closeAll();
      response(command.id, { closed: true });
      setTimeout(() => process.exit(0), 10);
      return;
    }
    const terminal = getTerminal(command.sessionId);
    if (command.action === 'write') terminal.write(command.data);
    if (command.action === 'resize') terminal.resize(command.columns, command.rows);
    if (command.action === 'close') {
      terminal.kill();
      terminals.delete(command.sessionId);
    }
    response(command.id, { ok: true });
  } catch (error) {
    failure(command.id, error);
  }
};

const fatal = (error: unknown) => {
  if (failing) return;
  failing = true;
  send({ type: 'fatal', error: errorText(error) });
  closeAll();
  setTimeout(() => process.exit(1), 10);
};

process.stdout.on('drain', () => {
  for (const terminal of terminals.values()) terminal.resume();
});
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
process.on('SIGTERM', () => { closeAll(); process.exit(0); });
process.on('SIGINT', () => { closeAll(); process.exit(0); });

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  try { handle(JSON.parse(line) as TerminalCommand); } catch (error) { fatal(error); }
});
input.on('close', () => { closeAll(); process.exit(0); });
send({ type: 'ready' });
