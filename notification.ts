#!/usr/bin/env bun
/**
 * Notification hook — logs notification events, optional TTS.
 */

import { readStdinJson, parseCliFlags } from './lib/stdin';
import { appendToJsonLog } from './lib/log';
import { ensureSessionLogDir, getProjectName } from './lib/constants';
import { loadConfig } from './lib/config';
import { resolveTTSProvider } from './lib/tts/resolver';
import { speakWithLock } from './lib/queue/tts-queue';
import { loadTemplates, pickAndRender } from './lib/templates/loader';
import { logTTSActivity } from './lib/activity-log';
import type { NotificationHookInput } from './lib/types';
import { join } from 'path';

async function main(): Promise<void> {
  const flags = parseCliFlags();
  const input = await readStdinJson<NotificationHookInput>();

  const sessionId = input.session_id ?? 'unknown';
  const message = input.message ?? '';

  // Log the notification
  const logDir = ensureSessionLogDir(sessionId);
  appendToJsonLog(join(logDir, 'notification.json'), input);

  console.error(`Notification hook called with message: '${message}'`);

  if (flags.notify) {
    // Skip TTS for the generic "waiting for input" message
    if (message === 'Claude is waiting for your input') {
      console.error('Skipping TTS for generic "waiting for input" message');
    } else {
      console.error('Notification hook: --notify flag detected, calling TTS');
      await announceNotification(sessionId);
    }
  } else {
    console.error('Notification hook: --notify flag NOT set, skipping TTS');
  }
}

async function announceNotification(sessionId: string): Promise<void> {
  try {
    const config = loadConfig();
    if (!config.tts.enabled || !config.tts.hookToggles.notification) {
      console.error('Notification: TTS disabled by config toggle');
      return;
    }

    const provider = resolveTTSProvider();
    if (!provider) {
      console.error('No TTS provider available');
      return;
    }

    const userName = config.tts.userName || '';
    const includeName = userName && Math.random() < config.tts.nameIncludeProbability;

    const templates = loadTemplates();
    const templateList = includeName
      ? templates.notification.withName
      : templates.notification.withoutName;

    const ttsMessage = pickAndRender(templateList, {
      projectName: getProjectName(),
      userName,
    });

    console.error(`TTS: Speaking: '${ttsMessage}'`);
    const ttsStart = Date.now();
    let ttsSuccess = true;
    let ttsError: string | undefined;
    try {
      await speakWithLock(provider, ttsMessage);
      console.error('TTS completed successfully');
    } catch (speakErr) {
      ttsSuccess = false;
      ttsError = String(speakErr);
      console.error(`TTS error: ${speakErr}`);
    } finally {
      logTTSActivity({
        hookType: 'notification',
        sessionId,
        agentName: null,
        agentType: null,
        message: ttsMessage,
        provider: provider.name,
        durationMs: Date.now() - ttsStart,
        success: ttsSuccess,
        error: ttsError,
      });
    }
  } catch (err) {
    console.error(`TTS error: ${err}`);
  }
}

main().catch(() => process.exit(0));
