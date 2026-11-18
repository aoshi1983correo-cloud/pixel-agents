import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { activityInput, privateActivity } from '../../../privateActivity.js';
import { AGY_READING_TOOLS } from './constants.js';

type RecordValue = Record<string, unknown>;
export function object(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

/** Keep prompts, command arguments, patches and tool output out of office messages. */
export function formatToolStatus(name: string, input?: unknown): string {
  return privateActivity(name, input);
}

export function parseRecord(record: RecordValue): AgentEvent | null {
  if (record.type === 'SESSION_END') return { kind: 'sessionEnd' };
  if (record.type === 'PERMISSION_REQUEST') return { kind: 'permissionRequest' };
  if (record.type === 'TURN_END') return { kind: 'turnEnd' };
  if (record.type === 'USER_INPUT')
    return { kind: 'toolStart', toolId: 'antigravity-thinking', toolName: 'Thinking' };
  if (record.type === 'PLANNER_RESPONSE') {
    if (Array.isArray(record.tool_calls) && record.tool_calls.length) {
      const name = object(record.tool_calls[0]).name;
      return {
        kind: 'toolStart',
        toolId: `${record.step_index}:0`,
        toolName: typeof name === 'string' ? name : 'Tool',
        input: activityInput(object(record.tool_calls[0]).args),
      };
    }
    return { kind: 'turnEnd' };
  }
  return null;
}

/** Passive Antigravity discovery; deliberately never installed. */
export const antigravityProvider: HookProvider = {
  kind: 'hook',
  id: 'antigravity',
  displayName: 'Antigravity',
  protocolVersion: 1,
  normalizeHookEvent: () => null,
  installHooks: async () => {
    throw new Error('Antigravity uses read-only transcript discovery');
  },
  uninstallHooks: async () => {},
  areHooksInstalled: async () => false,
  consentDisclosure: () => ({
    headline: 'Antigravity',
    disclosure: 'Read-only session discovery. No hooks or settings are written.',
  }),
  formatToolStatus,
  permissionExemptTools: AGY_READING_TOOLS,
  subagentToolNames: new Set(),
  readingTools: AGY_READING_TOOLS,
  getAllSessionRoots: () => [
    process.env.PIXEL_AGENTS_AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli'),
  ],
  sessionFilePattern: 'transcript.jsonl',
  parseTranscriptLine: (line) => {
    try {
      return parseRecord(object(JSON.parse(line)));
    } catch {
      return null;
    }
  },
};
