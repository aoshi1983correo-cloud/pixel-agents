import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { activityInput, privateActivity } from '../../../privateActivity.js';
import { CODEX_READING_TOOLS } from './constants.js';

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
  const p = object(record.payload);
  const type = p.type;
  if (record.type === 'session_meta') {
    return { kind: 'sessionStart', cwd: typeof p.cwd === 'string' ? p.cwd : undefined };
  }
  if (record.type === 'event_msg') {
    switch (type) {
      case 'task_started':
      case 'turn_started':
      case 'user_message':
        return { kind: 'toolStart', toolId: 'codex-thinking', toolName: 'Thinking' };
      case 'task_complete':
      case 'turn_complete':
      case 'turn_aborted':
        return { kind: 'turnEnd' };
      case 'session_end':
      case 'shutdown_complete':
        return { kind: 'sessionEnd' };
      case 'exec_approval_request':
      case 'apply_patch_approval_request':
      case 'permission_request':
        return { kind: 'permissionRequest' };
      case 'exec_command_begin':
      case 'patch_apply_begin':
        return {
          kind: 'toolStart',
          toolId: String(p.call_id ?? type),
          toolName: type === 'patch_apply_begin' ? 'apply_patch' : 'exec_command',
          input: activityInput(p),
        };
      case 'exec_command_end':
      case 'patch_apply_end':
        return { kind: 'toolEnd', toolId: String(p.call_id ?? '') };
      case 'item_completed': {
        const item = object(p.item);
        if (item.type === 'UserMessage')
          return { kind: 'toolStart', toolId: 'codex-thinking', toolName: 'Thinking' };
        return null;
      }
    }
  }
  if (record.type !== 'response_item') return null;
  if (type === 'function_call' || type === 'custom_tool_call') {
    const name = typeof p.name === 'string' ? p.name.split('.').pop()! : 'Tool';
    if (name === 'request_user_input') return { kind: 'turnEnd', awaitingInput: true };
    // Commands remain executions: guessing whether arbitrary shell code reads or writes is unsafe.
    return {
      kind: 'toolStart',
      toolId: String(p.call_id ?? 'codex-tool'),
      toolName: name,
      input: activityInput(p.arguments ?? p.input),
    };
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    return { kind: 'toolEnd', toolId: String(p.call_id ?? 'codex-tool') };
  }
  return null;
}

/** Read-only counterpart to PR #409's hook provider; deliberately never installed. */
export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,
  normalizeHookEvent: () => null,
  installHooks: async () => {
    throw new Error('Codex uses read-only transcript discovery');
  },
  uninstallHooks: async () => {},
  areHooksInstalled: async () => false,
  consentDisclosure: () => ({
    headline: 'Codex',
    disclosure: 'Read-only session discovery. No hooks or settings are written.',
  }),
  formatToolStatus,
  permissionExemptTools: CODEX_READING_TOOLS,
  subagentToolNames: new Set(),
  readingTools: CODEX_READING_TOOLS,
  getAllSessionRoots: () => [
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
  ],
  sessionFilePattern: 'rollout-*.jsonl',
  parseTranscriptLine: (line) => {
    try {
      return parseRecord(object(JSON.parse(line)));
    } catch {
      return null;
    }
  },
};
