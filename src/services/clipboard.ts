import { runPowerShell } from '../util/powershell';

export const readClipboard = async (signal?: AbortSignal) => {
  const encoded = await runPowerShell(`$v=[string](Get-Clipboard -Raw -Format Text); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v))`, 15_000, signal);
  return Buffer.from(encoded, 'base64').toString('utf8');
};

export const writeClipboard = async (text: string, signal?: AbortSignal) => {
  const value = Buffer.from(text, 'utf8').toString('base64');
  await runPowerShell(`$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${value}')); Set-Clipboard -Value $v`, 15_000, signal);
  return { written: Buffer.byteLength(text) };
};

export const clearClipboard = async (signal?: AbortSignal) => {
  await runPowerShell('Set-Clipboard -Value $null', 15_000, signal);
  return { cleared: true };
};
