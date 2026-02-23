#!/usr/bin/env bun
/**
 * Claude Code Hooks Manager — Bun HTTP server for configuring the TTS hook system.
 * Serves a vanilla HTML/CSS/JS frontend and provides JSON API routes.
 *
 * Run: bun run tts-app/server.ts
 * Open: http://localhost:3455
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { loadConfig, DEFAULTS, deepMerge, resetConfigCache, type HooksConfig } from '../lib/config';
import { getAllProviders, resolveTTSProvider } from '../lib/tts/resolver';
import { loadTemplates, resetTemplateCache } from '../lib/templates/loader';
import { DEFAULT_TEMPLATES, TONE_TEMPLATES } from '../lib/templates/defaults';
import { normalizeTTSText } from '../lib/tts/normalizer';
import { logTTSActivity, ACTIVITY_LOG_PATH } from '../lib/activity-log';
import type { TTSActivityEntry } from '../lib/types';

const PORT = parseInt(process.env.PORT || '', 10) || loadConfig().server?.port || 3455;
const PUBLIC_DIR = join(import.meta.dir, 'public');
const CONFIG_PATH = join(import.meta.dir, '..', 'hooks.config.json');

/**
 * Find the project root .env file.
 * Walk up from tts-app/ → .claude/hooks/ → .claude/ → project root.
 * Also accept CLAUDE_PROJECT_DIR if set.
 */
function findEnvPath(): string {
  // Prefer explicit env var if Claude Code set it
  if (process.env.CLAUDE_PROJECT_DIR) {
    return join(process.env.CLAUDE_PROJECT_DIR, '.env');
  }
  // tts-app/ → hooks/ → .claude/ → project root
  const projectRoot = resolve(import.meta.dir, '..', '..', '..');
  return join(projectRoot, '.env');
}

const ENV_PATH = findEnvPath();

/** Parse a .env file into a key-value map (preserves order for rewrite) */
function parseEnvFile(path: string): { lines: string[]; vars: Record<string, string> } {
  const lines: string[] = [];
  const vars: Record<string, string> = {};
  if (!existsSync(path)) return { lines, vars };

  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      lines.push(line);
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch { /* ignore parse errors */ }
  return { lines, vars };
}

/** Write/update keys in the .env file. Only touches the specified keys. */
function writeEnvKeys(updates: Record<string, string>): void {
  const { lines, vars } = parseEnvFile(ENV_PATH);
  const updatedKeys = new Set<string>();

  // Update existing lines in-place
  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in updates) {
      updatedKeys.add(key);
      if (updates[key] === '') return null; // remove empty keys
      return `${key}=${updates[key]}`;
    }
    return line;
  }).filter((line): line is string => line !== null);

  // Append new keys that weren't in the file yet
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key) && value) {
      newLines.push(`${key}=${value}`);
    }
  }

  // Ensure trailing newline
  const content = newLines.join('\n').trimEnd() + '\n';
  writeFileSync(ENV_PATH, content, 'utf-8');

  // Reload into process.env
  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

/**
 * Load the project .env into process.env on startup.
 * This replaces loadProjectEnv() which needs CLAUDE_PROJECT_DIR.
 */
function loadEnvOnStartup(): void {
  const { vars } = parseEnvFile(ENV_PATH);
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvOnStartup();
console.log(`[Hooks Manager] .env path: ${ENV_PATH} (exists: ${existsSync(ENV_PATH)})`);

/** MIME types for static file serving */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Read the raw user config (not merged with defaults) */
function readUserConfig(): Partial<HooksConfig> {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

/** Write user config overrides to disk */
function writeUserConfig(config: Partial<HooksConfig>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  // Reset caches so next loadConfig() picks up changes
  resetConfigCache();
  resetTemplateCache();
}

/** API key names to check for env status */
const API_KEY_NAMES = [
  'UNREAL_SPEECH_API_KEY',
  'ELEVENLABS_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
];

/** JSON response helper */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/** Handle API routes */
async function handleAPI(req: Request, path: string): Promise<Response> {
  // GET /api/config — full merged config
  if (path === '/api/config' && req.method === 'GET') {
    resetConfigCache();
    return jsonResponse(loadConfig());
  }

  // PUT /api/config — write user overrides
  if (path === '/api/config' && req.method === 'PUT') {
    try {
      const body = await req.json() as Partial<HooksConfig>;
      const current = readUserConfig();
      const merged = deepMerge(current as Record<string, unknown>, body as Record<string, unknown>);
      writeUserConfig(merged as Partial<HooksConfig>);
      resetConfigCache();
      return jsonResponse({ ok: true, config: loadConfig() });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 400);
    }
  }

  // GET /api/providers — list providers with availability
  if (path === '/api/providers' && req.method === 'GET') {
    return jsonResponse(getAllProviders());
  }

  // POST /api/tts/test — test TTS
  if (path === '/api/tts/test' && req.method === 'POST') {
    try {
      const { text, provider: providerName } = await req.json() as { text: string; provider?: string };
      if (!text) return jsonResponse({ ok: false, error: 'text is required' }, 400);

      const start = Date.now();
      let provider;

      if (providerName) {
        // Import specific provider
        const providers = getAllProviders();
        const match = providers.find(p => p.name === providerName);
        if (!match) return jsonResponse({ ok: false, error: `Unknown provider: ${providerName}` }, 400);
        if (!match.available) return jsonResponse({ ok: false, error: `Provider ${providerName} is not available` }, 400);

        // Instantiate the specific provider
        const { resolveTTSProvider: resolve } = await import('../lib/tts/resolver');
        resetConfigCache();
        // Temporarily set provider priority to just the requested one
        const config = readUserConfig();
        const originalPriority = config.tts?.providerPriority;
        writeUserConfig(deepMerge(config as Record<string, unknown>, { tts: { providerPriority: [providerName] } }) as Partial<HooksConfig>);
        resetConfigCache();
        provider = resolve();
        // Restore original priority
        if (originalPriority) {
          writeUserConfig(deepMerge(readUserConfig() as Record<string, unknown>, { tts: { providerPriority: originalPriority } }) as Partial<HooksConfig>);
        } else {
          const restored = readUserConfig();
          if (restored.tts) {
            delete (restored.tts as Record<string, unknown>).providerPriority;
            if (Object.keys(restored.tts).length === 0) delete (restored as Record<string, unknown>).tts;
          }
          writeUserConfig(restored);
        }
        resetConfigCache();
      } else {
        resetConfigCache();
        provider = resolveTTSProvider();
      }

      if (!provider) {
        return jsonResponse({ ok: false, error: 'No TTS provider available' }, 500);
      }

      await provider.speak(normalizeTTSText(text));
      const duration = Date.now() - start;

      // Log test TTS to activity log
      logTTSActivity({
        hookType: 'test',
        sessionId: 'test-harness',
        agentName: null,
        agentType: null,
        message: text,
        provider: provider.name,
        durationMs: duration,
        success: true,
      });

      return jsonResponse({ ok: true, provider: provider.name, duration });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 500);
    }
  }

  // GET /api/templates — merged templates
  if (path === '/api/templates' && req.method === 'GET') {
    resetTemplateCache();
    return jsonResponse(loadTemplates());
  }

  // PUT /api/templates — write template overrides
  if (path === '/api/templates' && req.method === 'PUT') {
    try {
      const body = await req.json();
      const current = readUserConfig();
      current.templates = deepMerge(
        (current.templates ?? {}) as Record<string, unknown>,
        body as Record<string, unknown>,
      );
      writeUserConfig(current);
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 400);
    }
  }

  // GET /api/env-status — which API keys are set (booleans only)
  if (path === '/api/env-status' && req.method === 'GET') {
    const status: Record<string, boolean> = {};
    for (const key of API_KEY_NAMES) {
      status[key] = !!process.env[key];
    }
    return jsonResponse(status);
  }

  // PUT /api/env-keys — write API keys to .env file
  if (path === '/api/env-keys' && req.method === 'PUT') {
    try {
      const body = await req.json() as Record<string, string>;
      // Only allow known API key names
      const filtered: Record<string, string> = {};
      for (const key of API_KEY_NAMES) {
        if (key in body) {
          filtered[key] = body[key];
        }
      }
      if (Object.keys(filtered).length === 0) {
        return jsonResponse({ ok: false, error: 'No valid API key names provided' }, 400);
      }
      writeEnvKeys(filtered);
      // Return updated status
      const status: Record<string, boolean> = {};
      for (const key of API_KEY_NAMES) {
        status[key] = !!process.env[key];
      }
      return jsonResponse({ ok: true, envStatus: status, envPath: ENV_PATH });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 400);
    }
  }

  // GET /api/defaults — raw defaults object
  if (path === '/api/defaults' && req.method === 'GET') {
    return jsonResponse({ config: DEFAULTS, templates: DEFAULT_TEMPLATES, availableTones: Object.keys(TONE_TEMPLATES) });
  }

  // GET /api/server-info — current running port
  if (path === '/api/server-info' && req.method === 'GET') {
    return jsonResponse({ port: PORT });
  }

  // GET /api/activity-log — read activity log with optional filters
  if (path === '/api/activity-log' && req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const hookTypeFilter = url.searchParams.get('hookType');
      const sessionFilter = url.searchParams.get('sessionId');
      const limit = parseInt(url.searchParams.get('limit') ?? '200') || 200;
      const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0;

      let entries: TTSActivityEntry[] = [];
      if (existsSync(ACTIVITY_LOG_PATH)) {
        try {
          const raw = readFileSync(ACTIVITY_LOG_PATH, 'utf-8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) entries = parsed;
        } catch { /* corrupt file — return empty */ }
      }

      // Build sessions map (before filtering)
      const sessions: Record<string, number> = {};
      for (const e of entries) {
        sessions[e.sessionId] = (sessions[e.sessionId] ?? 0) + 1;
      }

      // Apply filters
      if (hookTypeFilter) {
        const types = hookTypeFilter.split(',');
        entries = entries.filter(e => types.includes(e.hookType));
      }
      if (sessionFilter) {
        entries = entries.filter(e => e.sessionId === sessionFilter);
      }

      const total = entries.length;

      // Reverse chronological, then paginate
      entries = entries.reverse().slice(offset, offset + limit);

      return jsonResponse({ entries, total, sessions });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // POST /api/activity-log/clear — clear the activity log
  if (path === '/api/activity-log/clear' && req.method === 'POST') {
    try {
      writeFileSync(ACTIVITY_LOG_PATH, '[]', 'utf-8');
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) }, 500);
    }
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

/** Serve static files from public/ */
function serveStatic(path: string): Response {
  // Default to index.html
  if (path === '/' || path === '') path = '/index.html';

  const filePath = join(PUBLIC_DIR, path);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return new Response('Forbidden', { status: 403 });
  }

  if (!existsSync(filePath)) {
    return new Response('Not Found', { status: 404 });
  }

  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
  const content = readFileSync(filePath);

  return new Response(content, {
    headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' },
  });
}

/** Main request handler */
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Serve favicon (browsers request /favicon.ico automatically)
    if (path === '/favicon.ico' || path === '/favicon.png') {
      const faviconPath = join(PUBLIC_DIR, 'images', 'favicon.png');
      if (existsSync(faviconPath)) {
        return new Response(readFileSync(faviconPath), {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
        });
      }
    }

    // API routes
    if (path.startsWith('/api/')) {
      return handleAPI(req, path);
    }

    // Static files
    return serveStatic(path);
  },
});

console.log(`Claude Code Hooks Manager running at http://localhost:${server.port}`);
