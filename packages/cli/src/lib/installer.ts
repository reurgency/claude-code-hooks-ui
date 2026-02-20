/**
 * Clone / merge hooks from GitHub repo, run bun install.
 * Mirrors the bash install.sh logic in TypeScript.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { info, ok, warn, err } from './logger.js';

const HOOKS_REPO = 'https://github.com/reurgency/claude-code-hooks-ui.git';

function run(cmd: string, args: string[], opts?: { cwd?: string }): string {
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    cwd: opts?.cwd,
    timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function runPassthrough(cmd: string, args: string[], opts?: { cwd?: string }): void {
  execFileSync(cmd, args, {
    cwd: opts?.cwd,
    timeout: 120_000,
    stdio: 'inherit',
  });
}

/** Top-level names to skip when merging a clone into an existing hooks dir. */
const MERGE_EXCLUDES = new Set([
  'node_modules', '.git', 'logs', '.claude',
  '.codemill', '.DS_Store', '_archive_py', 'utils', '.env',
]);

/**
 * Recursively copy files from src into dest, skipping excluded names
 * and never overwriting existing files (--ignore-existing behaviour).
 */
function mergeDir(src: string, dest: string, excludes: Set<string>): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (excludes.has(entry.name)) continue;

    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      if (!existsSync(destPath)) mkdirSync(destPath, { recursive: true });
      mergeDir(srcPath, destPath, excludes);
    } else {
      // Only copy if the file doesn't already exist (preserve user files)
      if (!existsSync(destPath)) {
        copyFileSync(srcPath, destPath);
      }
    }
  }
}

/**
 * Clone hooks repo into target .claude/hooks/ directory.
 * If the directory already exists, merge new files without overwriting.
 */
export function cloneHooks(hooksDir: string, claudeDir: string): void {
  if (existsSync(hooksDir)) {
    // Check if it's already our git clone
    const gitDir = join(hooksDir, '.git');
    if (existsSync(gitDir)) {
      try {
        const remoteUrl = run('git', ['-C', hooksDir, 'config', '--get', 'remote.origin.url']);
        if (remoteUrl.includes('claude-code-hooks')) {
          warn(`${hooksDir} is already a hooks-manager clone.`);
          warn('Use "update" command to pull latest changes instead.');
          process.exit(1);
        }
      } catch {
        // Not a git repo or no remote — continue with merge
      }
    }

    // Existing hooks dir — clone to temp, then merge
    warn(`${hooksDir} already exists — merging hooks into existing directory...`);
    info('Existing files will NOT be overwritten.');

    const tmpDir = join(claudeDir, '.hooks-tmp-' + Date.now());
    try {
      info('Cloning hooks repo to temp directory...');
      runPassthrough('git', ['clone', '--depth', '1', HOOKS_REPO, tmpDir]);

      info('Merging into existing hooks directory...');
      mergeDir(tmpDir, hooksDir, MERGE_EXCLUDES);

      ok('Hooks merged into existing directory (existing files preserved)');
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } else {
    // Fresh clone
    info('Cloning hooks repo...');
    mkdirSync(claudeDir, { recursive: true });
    runPassthrough('git', ['clone', HOOKS_REPO, hooksDir]);
  }

  ok(`Hooks installed at ${hooksDir}`);
}

/**
 * Update existing hooks installation via git pull --ff-only.
 */
export function updateHooks(hooksDir: string): void {
  const gitDir = join(hooksDir, '.git');
  if (!existsSync(gitDir)) {
    err(`${hooksDir} is not a git repo. Use a fresh install instead.`);
    process.exit(1);
  }
  info('Updating hooks via git pull...');
  runPassthrough('git', ['-C', hooksDir, 'pull', '--ff-only']);
  ok('Hooks updated');
}

/**
 * Install bun dependencies in hooks directory.
 */
export function installDeps(hooksDir: string): void {
  info('Installing dependencies...');
  runPassthrough('bun', ['install'], { cwd: hooksDir });
  ok('Dependencies installed');
}

/**
 * Write API keys to .env file in hooks directory.
 * Only writes keys that are provided (non-empty).
 */
export function writeEnvFile(
  envPath: string,
  keys: { anthropic?: string; openai?: string; elevenlabs?: string; unrealSpeech?: string },
): void {
  const lines: string[] = [];

  if (keys.anthropic) lines.push(`ANTHROPIC_API_KEY=${keys.anthropic}`);
  if (keys.openai) lines.push(`OPENAI_API_KEY=${keys.openai}`);
  if (keys.elevenlabs) lines.push(`ELEVENLABS_API_KEY=${keys.elevenlabs}`);
  if (keys.unrealSpeech) lines.push(`UNREAL_SPEECH_API_KEY=${keys.unrealSpeech}`);

  if (lines.length === 0) return;

  // If .env already exists, append only new keys
  let existing = '';
  try {
    existing = readFileSync(envPath, 'utf-8');
  } catch { /* file doesn't exist */ }

  const newLines: string[] = [];
  for (const line of lines) {
    const keyName = line.split('=')[0];
    if (!existing.includes(keyName + '=')) {
      newLines.push(line);
    }
  }

  if (newLines.length > 0) {
    const content = existing
      ? existing.trimEnd() + '\n' + newLines.join('\n') + '\n'
      : newLines.join('\n') + '\n';
    writeFileSync(envPath, content, 'utf-8');
    info(`Wrote ${newLines.length} API key(s) to .env`);
  }
}
