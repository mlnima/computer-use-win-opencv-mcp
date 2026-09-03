import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { normalizeIp } from './util/ip';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(packageRoot, '.env'), quiet: true });

export type ServerConfig = {
  authToken: string;
  allowExampleTokenOnLan: boolean;
  allowedClientIps: string[];
  host: string;
  port: number;
  allowedOrigins: string[];
  runtimeDir: string;
  screenshotMaxBytes: number;
  screenshotMaxSide: number;
  resourceTtlMs: number;
  resourceMaxBytes: number;
  resourceMaxItems: number;
  observationTtlMs: number;
  maxElements: number;
  ocrEnabled: boolean;
  ocrLanguages: string;
  ocrLangPath?: string;
  openCvEnabled: boolean;
  visionApiUrl?: string;
  visionApiKey?: string;
  visionModel?: string;
  visionTimeoutMs: number;
  visualChangeThreshold: number;
  maxTimelineMs: number;
  maxTimelineEvents: number;
  maxHttpSessions: number;
  httpSessionIdleMs: number;
  maxTerminalSessions: number;
  terminalIdleMs: number;
};

const numberValue = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
};

const boolValue = (name: string, fallback: boolean) => {
  const value = process.env[name]?.trim().toLowerCase();
  return value ? ['1', 'true', 'yes', 'on'].includes(value) : fallback;
};

const ratioValue = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
};

const pathOrUrl = (value?: string) => value
  ? /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : path.resolve(packageRoot, value)
  : undefined;

export const loadConfig = (): ServerConfig => ({
  authToken: process.env.COMPUTER_USE_AUTH_TOKEN || 'change.me',
  allowExampleTokenOnLan: boolValue('COMPUTER_USE_ALLOW_EXAMPLE_TOKEN_ON_LAN', false),
  allowedClientIps: (process.env.COMPUTER_USE_ALLOWED_CLIENT_IPS || '').split(',').map(normalizeIp).filter((value): value is string => Boolean(value)),
  host: process.env.COMPUTER_USE_HOST || '127.0.0.1',
  port: numberValue('COMPUTER_USE_PORT', 7331),
  allowedOrigins: (process.env.COMPUTER_USE_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  runtimeDir: process.env.COMPUTER_USE_RUNTIME_DIR
    ? path.resolve(packageRoot, process.env.COMPUTER_USE_RUNTIME_DIR)
    : path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'computer-use-win-opencv-mcp'),
  screenshotMaxBytes: numberValue('COMPUTER_USE_SCREENSHOT_MAX_BYTES', 5 * 1024 * 1024),
  screenshotMaxSide: numberValue('COMPUTER_USE_SCREENSHOT_MAX_SIDE', 2560),
  resourceTtlMs: numberValue('COMPUTER_USE_RESOURCE_TTL_MS', 300_000),
  resourceMaxBytes: Math.max(32 * 1024 * 1024, numberValue('COMPUTER_USE_RESOURCE_MAX_BYTES', 128 * 1024 * 1024)),
  resourceMaxItems: Math.max(16, numberValue('COMPUTER_USE_RESOURCE_MAX_ITEMS', 512)),
  observationTtlMs: numberValue('COMPUTER_USE_OBSERVATION_TTL_MS', 30_000),
  maxElements: numberValue('COMPUTER_USE_MAX_ELEMENTS', 500),
  ocrEnabled: boolValue('COMPUTER_USE_OCR_ENABLED', true),
  ocrLanguages: process.env.COMPUTER_USE_OCR_LANGUAGES || 'eng',
  ocrLangPath: pathOrUrl(process.env.COMPUTER_USE_OCR_LANG_PATH),
  openCvEnabled: boolValue('COMPUTER_USE_OPENCV_ENABLED', true),
  visionApiUrl: process.env.COMPUTER_USE_VISION_API_URL || undefined,
  visionApiKey: process.env.COMPUTER_USE_VISION_API_KEY || undefined,
  visionModel: process.env.COMPUTER_USE_VISION_MODEL || undefined,
  visionTimeoutMs: numberValue('COMPUTER_USE_VISION_TIMEOUT_MS', 20_000),
  visualChangeThreshold: ratioValue('COMPUTER_USE_VISUAL_CHANGE_THRESHOLD', 0.1),
  maxTimelineMs: numberValue('COMPUTER_USE_MAX_TIMELINE_MS', 15_000),
  maxTimelineEvents: numberValue('COMPUTER_USE_MAX_TIMELINE_EVENTS', 500),
  maxHttpSessions: numberValue('COMPUTER_USE_MAX_HTTP_SESSIONS', 32),
  httpSessionIdleMs: numberValue('COMPUTER_USE_HTTP_SESSION_IDLE_MS', 900_000),
  maxTerminalSessions: numberValue('COMPUTER_USE_MAX_TERMINAL_SESSIONS', 16),
  terminalIdleMs: numberValue('COMPUTER_USE_TERMINAL_IDLE_MS', 1_800_000)
});
