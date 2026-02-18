/**
 * Merge hook registrations from settings.template.json into settings.local.json.
 *
 * Strategy: The template is authoritative for hook commands (the command strings
 * change across versions, e.g. adding $CLAUDE_PROJECT_DIR). User settings outside
 * the "hooks" key (permissions, statusLine, etc.) are always preserved.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { info, ok, warn } from './logger.js';
import type { JsonObject } from './config-manager.js';

function readJsonFile(path: string): JsonObject {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as JsonObject;
  } catch {
    return {};
  }
}

/**
 * Merge settings.template.json hooks into settings.local.json.
 *
 * - The "hooks" key is always replaced by the template (template wins).
 * - All other keys in settings.local.json are preserved untouched.
 */
export function mergeSettings(templatePath: string, settingsPath: string): void {
  if (!existsSync(templatePath)) {
    warn(`Template not found at ${templatePath} — skipping settings merge.`);
    return;
  }

  // Ensure .claude directory exists
  mkdirSync(dirname(settingsPath), { recursive: true });

  const template = readJsonFile(templatePath);
  const templateHooks = template.hooks;

  if (!templateHooks) {
    warn('Template has no "hooks" key — skipping settings merge.');
    return;
  }

  if (!existsSync(settingsPath)) {
    // No existing settings — create from template (hooks section only)
    info(`Creating ${settingsPath} from template...`);
    writeFileSync(settingsPath, JSON.stringify({ hooks: templateHooks }, null, 2) + '\n', 'utf-8');
    ok('Settings created');
    return;
  }

  // Existing settings — replace hooks, preserve everything else
  info('Updating hook registrations from template...');
  const existing = readJsonFile(settingsPath);
  existing.hooks = templateHooks;

  writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  ok('Hook commands updated from template (other settings preserved)');
}
