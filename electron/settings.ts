/**
 * Persisted application settings (API keys, defaults).
 *
 * Secrets live in the OS user-data directory instead of being baked into the
 * build. A legacy `.env` file is still read (repo root in development, user
 * data directory in production) so existing setups keep working; explicit
 * settings always win over `.env` values.
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Settings } from '../shared/contract.js';

let cache: Settings | undefined;

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  if (cache !== undefined) {
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Settings;
  } catch {
    cache = {};
  }
  return cache;
}

export function saveSettings(settings: Settings): Settings {
  cache = settings;
  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
  applySettingsToEnv(settings);
  return settings;
}

export function applySettingsToEnv(settings: Settings): void {
  if (settings.openrouter_api_key) {
    process.env['OPENROUTER_API_KEY'] = settings.openrouter_api_key;
  }
  if (settings.brave_search_api_key) {
    process.env['BRAVE_SEARCH_API_KEY'] = settings.brave_search_api_key;
  }
}

/** Minimal KEY=VALUE parser for the legacy `.env` files. */
function readEnvFile(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (key.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Load legacy `.env` files without overriding the real environment. */
export function loadDotEnv(): void {
  readEnvFile(join(app.getPath('userData'), '.env'));
  if (!app.isPackaged) {
    readEnvFile(join(app.getAppPath(), '.env'));
  }
}
