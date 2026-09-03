import process from 'node:process';
import { isIP } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config';
import { createRuntimeState } from './runtime/state';
import { shutdownRuntime } from './runtime/shutdown';
import { startHttpTransport, type HttpRuntime } from './transport/http';
import { startStdioTransport } from './transport/stdio';
import { normalizeIp } from './util/ip';

type TransportMode = 'stdio' | 'http' | 'all';

const argumentValue = (name: string) => {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
};

const transportMode = (): TransportMode => {
  const value = argumentValue('--transport') || 'stdio';
  if (!['stdio', 'http', 'all'].includes(value)) throw new Error(`Unsupported transport: ${value}`);
  return value as TransportMode;
};

const help = `computer-use-win-opencv-mcp

Usage:
  computer-use-win-opencv-mcp [--transport stdio|http|all] [--host HOST] [--port PORT]

Authentication and perception settings are read from environment variables. See .env.example.`;

const main = async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${help}\n`);
    return;
  }
  if (process.platform !== 'win32') throw new Error('This MCP server requires Windows.');
  const config = loadConfig();
  const host = argumentValue('--host');
  const port = Number(argumentValue('--port'));
  if (host) config.host = host;
  if (Number.isInteger(port) && port > 0 && port <= 65535) config.port = port;
  const mode = transportMode();
  const normalizedHost = normalizeIp(config.host);
  const loopback = config.host === 'localhost' || normalizedHost === '::1'
    || normalizedHost?.split('.')[0] === '127';
  const displayedHost = isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  const weakLanToken = !loopback && (config.authToken === 'change.me' || config.authToken.length < 24);
  if ((mode === 'http' || mode === 'all') && weakLanToken && (!config.allowExampleTokenOnLan || config.allowedClientIps.length === 0)) {
    throw new Error('Non-loopback HTTP with a weak token requires COMPUTER_USE_ALLOW_EXAMPLE_TOKEN_ON_LAN=true and COMPUTER_USE_ALLOWED_CLIENT_IPS.');
  }
  if ((mode === 'http' || mode === 'all') && weakLanToken) {
    process.stderr.write('Warning: COMPUTER_USE_ALLOW_EXAMPLE_TOKEN_ON_LAN exposes full computer control with a weak bearer token over plaintext HTTP.\n');
  }
  const state = createRuntimeState(config);
  let stdio: McpServer | undefined;
  let http: HttpRuntime | undefined;
  let stopping = false;
  let startup: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  const stop = (exitCode = 0) => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      const failures: unknown[] = [];
      try { await startup; } catch (error) { failures.push(error); }
      try { await stdio?.close(); } catch (error) { failures.push(error); }
      try { await http?.close(); } catch (error) { failures.push(error); }
      try { await shutdownRuntime(state); } catch (error) { failures.push(error); }
      if (failures.length) {
        const details = failures.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
        process.stderr.write(`Shutdown error: ${details}\n`);
      }
      process.exitCode = failures.length ? 1 : exitCode;
    })();
    return stopPromise;
  };
  process.once('SIGINT', () => { void stop(0); });
  process.once('SIGTERM', () => { void stop(0); });
  process.once('SIGHUP', () => { void stop(0); });
  startup = (async () => {
    if (mode === 'stdio' || mode === 'all') {
      const started = await startStdioTransport(state);
      if (stopping) await started.close();
      else stdio = started;
    }
    if (!stopping && (mode === 'http' || mode === 'all')) {
      const started = await startHttpTransport(state);
      if (stopping) await started.close();
      else {
        http = started;
        process.stderr.write(`MCP Streamable HTTP listening on http://${displayedHost}:${config.port}/mcp\n`);
        if (config.authToken === 'change.me') process.stderr.write('Warning: replace the example bearer token before using an untrusted network.\n');
      }
    }
  })();
  try {
    await startup;
  } catch (error) {
    await stop(1);
    throw error;
  }
  if (stopping) {
    await stopPromise;
    return;
  }
  if (mode === 'stdio') process.stdin.once('end', () => { void stop(0); });
  if (mode === 'all') process.stdin.once('end', () => {
    const ended = stdio;
    stdio = undefined;
    void ended?.close().catch(() => undefined);
  });
};

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
