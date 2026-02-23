#!/usr/bin/env bun
/**
 * SessionEnd hook — logs session end, saves stats, optional TTS.
 */

import { readStdinJson, parseCliFlags } from './lib/stdin';
import { appendToJsonLog } from './lib/log';
import { ensureLocalLogDir, getProjectName } from './lib/constants';
import { loadConfig } from './lib/config';
import { resolveTTSProvider } from './lib/tts/resolver';
import { speakWithLock } from './lib/queue/tts-queue';
import { loadTemplates, pickAndRender } from './lib/templates/loader';
import { logTTSActivity } from './lib/activity-log';
import type { SessionEndHookInput } from './lib/types';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

async function main(): Promise<void> {
  const flags = parseCliFlags();
  const input = await readStdinJson<SessionEndHookInput>();

  const sessionId = input.session_id ?? 'unknown';
  const reason = input.reason ?? 'other';

  // Log the session end event
  const logDir = ensureLocalLogDir();
  appendToJsonLog(join(logDir, 'session_end.json'), {
    ...input,
    logged_at: new Date().toISOString(),
  });

  // Save session statistics
  if (flags.saveStats) {
    saveSessionStatistics(input);
  }

  // Announce session end via TTS
  if (flags.announce) {
    try {
      const cfg = loadConfig();
      if (!cfg.tts.enabled || !cfg.tts.hookToggles.sessionEnd) {
        return;
      }

      const provider = resolveTTSProvider();
      if (provider) {
        const templates = loadTemplates();
        const reasonKey = reason as keyof typeof templates.sessionEnd;
        const templateList = templates.sessionEnd[reasonKey] ?? templates.sessionEnd.other;
        const message = pickAndRender(templateList, {
          projectName: getProjectName(),
          userName: loadConfig().tts.userName || '',
        });
        const ttsStart = Date.now();
        let ttsSuccess = true;
        let ttsError: string | undefined;
        try {
          await speakWithLock(provider, message);
        } catch (speakErr) {
          ttsSuccess = false;
          ttsError = String(speakErr);
        } finally {
          logTTSActivity({
            hookType: 'sessionEnd',
            sessionId,
            agentName: null,
            agentType: null,
            message,
            provider: provider.name,
            durationMs: Date.now() - ttsStart,
            success: ttsSuccess,
            error: ttsError,
          });
        }
      }
    } catch { /* TTS failure is non-fatal */ }
  }
}

function saveSessionStatistics(input: SessionEndHookInput): void {
  try {
    const sessionId = input.session_id ?? 'unknown';
    const reason = input.reason ?? 'other';
    const transcriptPath = input.transcript_path ?? '';

    let messageCount = 0;
    if (transcriptPath && existsSync(transcriptPath)) {
      try {
        const content = readFileSync(transcriptPath, 'utf-8');
        messageCount = content.split('\n').filter(l => l.trim()).length;
      } catch { /* ignore */ }
    }

    const logDir = ensureLocalLogDir();
    appendToJsonLog(join(logDir, 'session_statistics.json'), {
      session_id: sessionId,
      ended_at: new Date().toISOString(),
      reason,
      message_count: messageCount,
    });
  } catch { /* stats errors are non-fatal */ }
}

main().catch(() => process.exit(0));
