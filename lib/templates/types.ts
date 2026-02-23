/**
 * Template type definitions for TTS message templates.
 */

/** Variables available for template substitution */
export interface TemplateVars {
  projectName: string;
  userName: string;
  activity?: string;
  lastActivity?: string;
  count?: number;
  agentName?: string;
  description?: string;
}

/** Template variants for stop hook */
export interface StopTemplates {
  withActivities: {
    single: { withName: string[]; withoutName: string[] };
    multiple: { withName: string[]; withoutName: string[] };
  };
  noActivities: { withName: string[]; withoutName: string[] };
}

/** Template variants for subagent stop hook */
export interface SubagentStopTemplates {
  withDescription: { withName: string[]; withoutName: string[] };
  noDescription: { withName: string[]; withoutName: string[] };
}

/** Template for notification hook */
export interface NotificationTemplates {
  withName: string[];
  withoutName: string[];
}

/** Template for session end hook */
export interface SessionEndTemplates {
  clear: string[];
  logout: string[];
  prompt_input_exit: string[];
  other: string[];
}

/** All templates */
export interface AllTemplates {
  stop: StopTemplates;
  subagentStop: SubagentStopTemplates;
  notification: NotificationTemplates;
  sessionEnd: SessionEndTemplates;
}
