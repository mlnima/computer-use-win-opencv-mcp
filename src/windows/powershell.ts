import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnvironment } from '../util/childEnvironment';

const execFileAsync = promisify(execFile);

const decodeXmlText = (value: string) => value
  .replace(/_x000D__x000A_/g, '\n')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const powerShellError = (cause: unknown) => {
  const stderr = String((cause as { stderr?: unknown })?.stderr || '').trim();
  const matches = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((match) => decodeXmlText(match[1]).trim())
    .filter(Boolean);
  const detail = matches.length > 0 ? matches.join('\n') : stderr && !stderr.includes('#< CLIXML') ? stderr : '';
  return new Error((detail || 'PowerShell desktop operation failed.').slice(0, 2000));
};

export const psLiteral = (value: string) => value.replace(/'/g, "''");

export const runPowerShell = async (script: string, timeout = 12_000, signal?: AbortSignal) => {
  if (process.platform !== 'win32') throw new Error('Windows desktop access requires Windows.');
  const wrapped = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = 'Stop'
${script}`;
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true, signal, env: childEnvironment() }
    );
    return stdout.trim();
  } catch (cause) {
    throw powerShellError(cause);
  }
};

export const runPowerShellJson = async <T>(script: string, fallback: T, timeout = 12_000, signal?: AbortSignal): Promise<T> => {
  const output = await runPowerShell(script, timeout, signal);
  return output ? JSON.parse(output) as T : fallback;
};

export const normalizePowerShellArray = <T>(value: T | T[] | null | undefined): T[] =>
  Array.isArray(value) ? value : value ? [value] : [];
