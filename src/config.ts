import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Runtime configuration. The API key is read here and handed to the Redmine
 * client only — nothing else in the process should ever touch it, and it must
 * never be written to stdout/stderr or returned in a tool result.
 */
/**
 * How the server authenticates to Redmine. Either a per-user API key
 * (My account -> API access key) or the login username/password over HTTP Basic.
 * Both require the REST API to be enabled in Redmine administration.
 */
export type Credential =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'basic'; username: string; password: string };

export interface Config {
  /** Base URL of the Redmine instance, no trailing slash (e.g. https://redmine.example.com). */
  url: string;
  credential: Credential;
  /** Absolute directory where downloaded attachments are stored. */
  attachmentDir: string;
  /** Refuse to download attachments larger than this. */
  maxAttachmentBytes: number;
  /** Images at or below this size are also returned inline as an MCP image block. */
  inlineImageMaxBytes: number;
  /** Text files at or below this size are also returned inline as text. */
  inlineTextMaxBytes: number;
}

const CONFIG_DIR = path.join(homedir(), '.redmine-mcp');
export const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const MiB = 1024 * 1024;
const KiB = 1024;

interface RawConfig {
  url?: unknown;
  apiKey?: unknown;
  username?: unknown;
  password?: unknown;
  attachmentDir?: unknown;
  maxAttachmentBytes?: unknown;
  inlineImageMaxBytes?: unknown;
  inlineTextMaxBytes?: unknown;
}

export class ConfigError extends Error {}

function readConfigFile(configPath: string): RawConfig {
  let text: string;
  try {
    // Strip a UTF-8 BOM: Notepad and PowerShell's Out-File commonly add one, and JSON.parse rejects it.
    text = readFileSync(configPath, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {}; // env-only configuration is allowed
    throw new ConfigError(`Cannot read config file ${configPath}: ${code ?? String(err)}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError(`Config file ${configPath} must contain a JSON object`);
    }
    return parsed as RawConfig;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Config file ${configPath} is not valid JSON`);
  }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ConfigError(`Config field "${name}" must be a string`);
  return value;
}

function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`Config field "${name}" must be a positive integer`);
  }
  return n;
}

function normalizeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`Redmine URL "${raw}" is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError('Redmine URL must use http:// or https://');
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new ConfigError('Redmine URL must not contain a query string, fragment, or credentials');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function resolveCredential(raw: RawConfig, env: NodeJS.ProcessEnv, configPath: string): Credential {
  const apiKey = env.REDMINE_API_KEY || optionalString(raw.apiKey, 'apiKey');
  if (apiKey) return { kind: 'apiKey', apiKey };

  const username = env.REDMINE_USERNAME || optionalString(raw.username, 'username');
  const password = env.REDMINE_PASSWORD || optionalString(raw.password, 'password');
  if (username && password) return { kind: 'basic', username, password };
  if (username || password) {
    throw new ConfigError('Both "username" and "password" are required for password authentication');
  }
  throw new ConfigError(
    `Redmine credentials missing: set "apiKey" (or "username" + "password") in ${configPath}, ` +
      'or REDMINE_API_KEY / REDMINE_USERNAME + REDMINE_PASSWORD',
  );
}

/**
 * Loads configuration from `%USERPROFILE%\.redmine-mcp\config.json` (or the
 * path in `REDMINE_MCP_CONFIG`). Environment variables `REDMINE_URL`,
 * `REDMINE_API_KEY`, `REDMINE_USERNAME`, `REDMINE_PASSWORD` and
 * `REDMINE_ATTACHMENT_DIR` take precedence over the file. An API key wins
 * over username/password when both are present.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const configPath = env.REDMINE_MCP_CONFIG || DEFAULT_CONFIG_PATH;
  const raw = readConfigFile(configPath);

  const url = env.REDMINE_URL || optionalString(raw.url, 'url');
  // Kept outside CONFIG_DIR on purpose: the README recommends denying Claude Code
  // access to CONFIG_DIR, and Claude still needs to read downloaded attachments.
  const attachmentDir =
    env.REDMINE_ATTACHMENT_DIR ||
    optionalString(raw.attachmentDir, 'attachmentDir') ||
    path.join(homedir(), 'redmine-attachments');

  if (!url) {
    throw new ConfigError(`Redmine URL missing: set "url" in ${configPath} or REDMINE_URL`);
  }

  return {
    url: normalizeUrl(url),
    credential: resolveCredential(raw, env, configPath),
    attachmentDir: path.resolve(attachmentDir),
    maxAttachmentBytes: optionalPositiveInt(raw.maxAttachmentBytes, 'maxAttachmentBytes') ?? 25 * MiB,
    inlineImageMaxBytes: optionalPositiveInt(raw.inlineImageMaxBytes, 'inlineImageMaxBytes') ?? 4 * MiB,
    inlineTextMaxBytes: optionalPositiveInt(raw.inlineTextMaxBytes, 'inlineTextMaxBytes') ?? 256 * KiB,
  };
}
