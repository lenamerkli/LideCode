/**
 * Runtime configuration for the engine.
 *
 * The previous server deployment hard-coded `/opt/LideCode`. In the Electron
 * app these locations are injected at startup (userData directory for the
 * access token, bundled resources for the Docker build context), while the
 * defaults preserve the old behaviour for headless/CLI usage.
 */

export interface PathsConfig {
  /** Directory holding mutable state such as the sandbox access token. */
  dataDir: string;
  /** Directory containing the Docker build context (DOCKERFILE, app.py, ...). */
  dockerContextDir: string;
}

let paths: PathsConfig = {
  dataDir: process.env['LIDECODE_DATA_DIR'] ?? '/opt/LideCode',
  dockerContextDir: process.env['LIDECODE_DOCKER_DIR'] ?? '/opt/LideCode/docker',
};

/** Override engine paths. Called once by the Electron main process at startup. */
export function configurePaths(overrides: Partial<PathsConfig>): void {
  paths = { ...paths, ...overrides };
}

export function getPaths(): PathsConfig {
  return paths;
}
