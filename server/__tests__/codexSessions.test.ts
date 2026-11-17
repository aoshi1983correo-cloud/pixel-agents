import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toPersistedAgent } from '../src/agentPersistence.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { CODEX_READ_BYTES } from '../src/providers/hook/codex/constants.js';
import { CodexSessionScanner } from '../src/providers/hook/codex/sessionScanner.js';

const io = vi.hoisted(() => ({ readLengths: [] as number[], failOpen: false }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (io.failOpen) {
        io.failOpen = false;
        throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      }
      return actual.openSync(...args);
    },
    readSync: (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number,
    ) => {
      io.readLengths.push(length);
      return actual.readSync(fd, buffer, offset, length, position);
    },
  };
});

describe('Codex read-only sessions (entirely synthetic)', () => {
  let root: string;
  let store: AgentStateStore;
  let scanner: CodexSessionScanner;
  let now: number;
  let messages: Record<string, unknown>[];
  const workspace = path.resolve('/synthetic-office');
  const record = (type: string, payload: unknown) =>
    JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload }) + '\n';
  const event = (type: string) => record('event_msg', { type });
  function file(id = 'synthetic-session', day = '18', cwd = workspace): string {
    const dir = path.join(root, '2026', '11', day);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `rollout-${id}.jsonl`);
    fs.writeFileSync(target, record('session_meta', { id, cwd }));
    return target;
  }
  const agent = () => [...store.values()][0];
  beforeEach(() => {
    io.readLengths = [];
    io.failOpen = false;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-synthetic-'));
    now = Date.parse('2026-11-18T00:00:00Z');
    store = new AgentStateStore();
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
    scanner = new CodexSessionScanner(store, {
      roots: [root],
      workspaces: () => [workspace],
      watchAll: () => false,
      now: () => now,
      idleMs: 10_000,
    });
  });
  afterEach(() => {
    scanner.stop();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts, executes a command, edits, waits, resumes and finishes a turn', () => {
    const target = file();
    fs.appendFileSync(target, event('task_started'));
    scanner.poll();
    expect(agent().directoryName).toContain('Codex');
    expect(agent().turnActive).toBe(true);
    for (const name of ['exec_command', 'apply_patch', 'read_file']) {
      fs.appendFileSync(
        target,
        record('response_item', {
          type: 'function_call',
          call_id: name,
          name,
          arguments: 'PRIVATE_SYNTHETIC_ARGUMENTS',
        }),
      );
      scanner.poll();
      expect(agent().activeToolIds.has(name)).toBe(true);
      fs.appendFileSync(
        target,
        record('response_item', {
          type: 'function_call_output',
          call_id: name,
          output: 'PRIVATE_SYNTHETIC_OUTPUT',
        }),
      );
      scanner.poll();
      expect(agent().activeToolIds.has(name)).toBe(false);
    }
    fs.appendFileSync(target, event('exec_approval_request'));
    scanner.poll();
    expect(agent().permissionSent).toBe(true);
    fs.appendFileSync(target, event('task_started'));
    scanner.poll();
    expect(agent().permissionSent).toBe(false);
    fs.appendFileSync(target, event('task_complete'));
    scanner.poll();
    expect(agent().isWaiting).toBe(true);
    expect(agent().activeToolIds.size).toBe(0);
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_SYNTHETIC');
    expect(toPersistedAgent(agent())).toBeNull();
  });

  it('buffers partial UTF-8 lines, skips invalid JSON and reads only new bytes', () => {
    const target = file();
    scanner.poll();
    const data = Buffer.from(
      record('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'edit-é' }),
    );
    const split = data.indexOf(Buffer.from('é')) + 1;
    fs.appendFileSync(target, data.subarray(0, split));
    scanner.poll();
    expect(store.size).toBe(0);
    fs.appendFileSync(target, data.subarray(split));
    fs.appendFileSync(target, '{broken json}\n');
    scanner.poll();
    expect(agent().activeToolIds.has('edit-é')).toBe(true);
    const count = agent().linesProcessed;
    scanner.poll();
    expect(agent().linesProcessed).toBe(count);
  });

  it('expires inactive sessions and re-adopts a resumed session', () => {
    const target = file();
    fs.appendFileSync(target, event('task_started'));
    scanner.poll();
    now += 10_001;
    scanner.poll();
    expect(store.size).toBe(0);
    fs.appendFileSync(target, event('task_started'));
    scanner.poll();
    expect(store.size).toBe(1);
  });

  it('ends a session explicitly and ignores old historical activity', () => {
    const target = file();
    fs.appendFileSync(target, event('task_started') + event('session_end'));
    scanner.poll();
    expect(store.size).toBe(0);
    now += 10_001;
    scanner.stop();
    scanner.poll();
    expect(store.size).toBe(0);
  });

  it('tracks two sessions and discovers a new date directory after midnight', () => {
    fs.appendFileSync(file('first'), event('task_started'));
    fs.appendFileSync(file('second'), event('task_started'));
    scanner.poll();
    expect(store.size).toBe(2);
    now += 3_001;
    fs.appendFileSync(file('tomorrow', '19'), event('task_started'));
    scanner.poll();
    expect(store.size).toBe(3);
    expect(new Set([...store.values()].map((a) => a.id)).size).toBe(3);
  });

  it('filters by cwd, with opt-in global discovery', () => {
    fs.appendFileSync(
      file('other', '18', path.resolve('/other-synthetic-project')),
      event('task_started'),
    );
    scanner.poll();
    expect(store.size).toBe(0);
    scanner.stop();
    scanner = new CodexSessionScanner(store, {
      roots: [root],
      workspaces: () => [],
      watchAll: () => true,
      now: () => now,
    });
    scanner.poll();
    expect(store.size).toBe(1);
  });

  it('handles an 11MB file with bounded reads, oversized lines and incremental growth', () => {
    const target = file();
    fs.appendFileSync(target, 'x'.repeat(11 * 1024 * 1024) + '\n' + event('task_started'));
    for (let i = 0; i < 50; i++) scanner.poll();
    expect(store.size).toBe(1);
    expect(io.readLengths.every((length) => length <= CODEX_READ_BYTES)).toBe(true);
    const calls = io.readLengths.length;
    scanner.poll();
    expect(io.readLengths.length).toBe(calls);
    fs.appendFileSync(target, event('task_complete'));
    scanner.poll();
    expect(agent().isWaiting).toBe(true);
  });

  it('retries a locked file without losing data and recovers from truncation', () => {
    const target = file();
    fs.appendFileSync(target, event('task_started'));
    io.failOpen = true;
    scanner.poll();
    expect(store.size).toBe(0);
    scanner.poll();
    expect(store.size).toBe(1);
    fs.writeFileSync(
      target,
      record('session_meta', { id: 'new', cwd: workspace }) + event('task_started'),
    );
    scanner.poll();
    expect(agent().sessionId).toBe('new');
  });

  it('uses the last context snapshot, never cumulative token spend', () => {
    const target = file();
    fs.appendFileSync(
      target,
      event('task_started') +
        record('event_msg', {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 123 },
            total_token_usage: { total_tokens: 99999 },
            model_context_window: 1000,
          },
        }),
    );
    scanner.poll();
    expect(agent().contextTokens).toBe(123);
    expect(agent().maxContextTokens).toBe(1000);
  });

  it('does not resurrect a character the user dismissed', () => {
    const target = file();
    fs.appendFileSync(target, event('task_started'));
    scanner.poll();
    store.delete(agent().id);
    fs.appendFileSync(target, event('task_started'));
    scanner.poll();
    expect(store.size).toBe(0);
  });

  it('normalizes new and legacy turn names and tolerates unrelated shapes', () => {
    expect(codexProvider.parseTranscriptLine!('null')).toBeNull();
    expect(codexProvider.parseTranscriptLine!('broken')).toBeNull();
    expect(codexProvider.parseTranscriptLine!(event('turn_started'))?.kind).toBe('toolStart');
    expect(codexProvider.parseTranscriptLine!(event('turn_complete'))?.kind).toBe('turnEnd');
    expect(codexProvider.parseTranscriptLine!(record('world_state', {}))).toBeNull();
    expect(
      codexProvider.parseTranscriptLine!(
        record('event_msg', { type: 'item_completed', item: { type: 'UserMessage' } }),
      )?.kind,
    ).toBe('toolStart');
  });

  it('detects appended bytes even when Windows directory timestamps stay frozen', () => {
    const target = file();
    const frozen = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(target, frozen, frozen);
    scanner.poll();
    fs.appendFileSync(target, event('task_started'));
    fs.utimesSync(target, frozen, frozen);
    scanner.poll();
    expect(store.size).toBe(1);
    expect(agent().turnActive).toBe(true);
  });

  it('deduplicates legacy and paginated starts and leaves approval as the last bubble', () => {
    const target = file();
    fs.appendFileSync(
      target,
      event('task_started') +
        record('event_msg', { type: 'item_completed', item: { type: 'UserMessage' } }),
    );
    scanner.poll();
    expect(messages.filter((m) => m.type === 'agentToolStart')).toHaveLength(1);
    fs.appendFileSync(target, event('exec_approval_request'));
    scanner.poll();
    expect(messages.at(-1)?.type).toBe('agentToolPermission');
    fs.appendFileSync(target, event('task_started'));
    scanner.poll();
    expect(messages.some((m) => m.type === 'agentToolPermissionClear')).toBe(true);
  });

  it('distinguishes a question from a permission request', () => {
    const target = file();
    fs.appendFileSync(
      target,
      event('task_started') +
        record('response_item', {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'question',
        }),
    );
    scanner.poll();
    expect(agent().isWaiting).toBe(true);
    expect(agent().permissionSent).toBe(false);
    expect(messages.at(-1)).toMatchObject({
      type: 'agentStatus',
      status: 'waiting',
      awaitingInput: true,
    });
  });

  it('applies changes to workspace scope without dismissing a session permanently', () => {
    let watchAll = true;
    scanner.stop();
    scanner = new CodexSessionScanner(store, {
      roots: [root],
      workspaces: () => [],
      watchAll: () => watchAll,
      now: () => now,
    });
    const target = file();
    fs.appendFileSync(target, event('task_started'));
    scanner.poll();
    expect(store.size).toBe(1);
    watchAll = false;
    scanner.poll();
    expect(store.size).toBe(0);
    watchAll = true;
    fs.appendFileSync(target, event('task_started'));
    scanner.poll();
    expect(store.size).toBe(1);
  });

  it('stops its polling timer and tolerates a missing sessions root', () => {
    vi.useFakeTimers();
    try {
      scanner.start();
      scanner.start();
      expect(vi.getTimerCount()).toBe(1);
      scanner.stop();
      expect(vi.getTimerCount()).toBe(0);
      fs.rmSync(root, { recursive: true });
      expect(() => scanner.poll()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
