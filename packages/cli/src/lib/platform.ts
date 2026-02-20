/**
 * OS detection and path normalization.
 * Mirrors the bash install.sh logic for cross-platform support.
 */

import { platform } from 'node:os';
import { resolve, join } from 'node:path';

export type Platform = 'macos' | 'linux' | 'windows' | 'unknown';

export function detectPlatform(): Platform {
  switch (platform()) {
    case 'darwin': return 'macos';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default: return 'unknown';
  }
}

/**
 * Normalize a path for the current OS.
 * On Windows, converts backslashes to forward slashes.
 *
 * Note: Does NOT convert drive letters (C:/ → /c/) because that Git Bash
 * convention breaks Node.js path.resolve(), which interprets /c/... as
 * a path from the current drive root (producing C:\c\...).
 */
export function normalizePath(p: string): string {
  if (detectPlatform() === 'windows') {
    p = p.replace(/\\/g, '/');
  }
  return p;
}

/**
 * Resolve a target directory to absolute path and derive all standard paths.
 */
export function resolveProjectPaths(targetDir: string) {
  const projectRoot = resolve(targetDir);
  return {
    projectRoot,
    claudeDir: join(projectRoot, '.claude'),
    hooksDir: join(projectRoot, '.claude', 'hooks'),
    settingsFile: join(projectRoot, '.claude', 'settings.local.json'),
    configFile: join(projectRoot, '.claude', 'hooks', 'hooks.config.json'),
    templateFile: join(projectRoot, '.claude', 'hooks', 'settings.template.json'),
    envFile: join(projectRoot, '.claude', 'hooks', '.env'),
  };
}
