/**
 * Filesystem locations for the Electron app.
 *
 * Paths are derived from Electron's `app.getAppPath()` (the repo root in
 * development, `app.asar` in a packaged build) rather than `__dirname`, so the
 * same code works whether the bundle is loaded as ESM or CommonJS.
 */

import { app } from 'electron';
import { join } from 'node:path';

/** Root of the application bundle. */
function appRoot(): string {
  return app.getAppPath();
}

/** Directory containing the Docker build context (DOCKERFILE, app.py, ...). */
export function dockerContextDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'docker') : join(appRoot(), 'src', 'docker');
}

/** Mutable application data (access token, settings). */
export function dataDir(): string {
  return app.getPath('userData');
}

/** Built Angular entry point to load when no dev server is configured. */
export function uiIndexPath(): string {
  return join(appRoot(), 'ui', 'dist', 'lidecode-ui', 'browser', 'index.html');
}

/** Path of the bundled preload script. */
export function preloadPath(): string {
  return join(appRoot(), 'dist-electron', 'preload.cjs');
}

/** URL of the Angular dev server, when running `npm run dev`. */
export function devServerUrl(): string | undefined {
  const url = process.env['LIDECODE_DEV_SERVER'];
  return url && url.length > 0 ? url : undefined;
}
