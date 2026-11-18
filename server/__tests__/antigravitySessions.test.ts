import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toPersistedAgent } from '../src/agentPersistence.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { antigravityProvider } from '../src/providers/hook/antigravity/antigravity.js';
import { AGY_READ_BYTES } from '../src/providers/hook/antigravity/constants.js';
import { AntigravitySessionScanner } from '../src/providers/hook/antigravity/sessionScanner.js';

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

describe('Antigravity read-only sessions (entirely synthetic)', () => {
  let root: string;
  let store: AgentStateStore;
  let scanner: AntigravitySessionScanner;
  let now: number;
  let messages: Record<string, unknown>[];
  const workspace = path.resolve('/synthetic-office');
  let step = 0;
  const record = (type: string, payload: Record<string, unknown> = {}) =>
    JSON.stringify({
      created_at: new Date(now).toISOString(),
      step_index: step++,
      type,
      status: 'DONE',
      ...payload,
    }) + '\n';
  const event = (type: string) => record(type);
  function file(id = 'synthetic-session', cwd = workspace): string {
    const dir = path.join(root, 'brain', id, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(target, '');
    fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
    const indexFile = path.join(root, 'cache', 'last_conversations.json');
    const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
    index[cwd] = id;
    fs.writeFileSync(indexFile, JSON.stringify(index));
    return target;
  }
  const agent = () => [...store.values()][0];
  beforeEach(() => {
    io.readLengths = [];
    io.failOpen = false;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-synthetic-'));
    now = Date.parse('2026-11-18T00:00:00Z');
    store = new AgentStateStore();
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
    scanner = new AntigravitySessionScanner(store, {
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

  it('tracks invented activity without forwarding private contents', () => {
    expect(antigravityProvider.formatToolStatus('read_file')).toBe('Reading');
    expect(antigravityProvider.parseTranscriptLine!('{broken')).toBeNull();
    const target = file();
    fs.appendFileSync(target, event('USER_INPUT'));
    scanner.poll();
    expect(agent().directoryName).toContain('Antigravity ·');
    for (const name of ['write_file', 'run_command', 'read_file']) {
      fs.appendFileSync(
        target,
        record('PLANNER_RESPONSE', {
          tool_calls: [{ name, args: { content: 'PRIVATE_SYNTHETIC' } }],
        }),
      );
      scanner.poll();
      expect([...agent().activeToolNames.values()]).toContain(name === 'read_file' ? 'Read' : name);
    }
    fs.appendFileSync(target, event('PERMISSION_REQUEST'));
    scanner.poll();
    expect(agent().permissionSent).toBe(true);
    fs.appendFileSync(target, event('USER_INPUT'));
    scanner.poll();
    expect(agent().permissionSent).toBe(false);
    fs.appendFileSync(target, event('PLANNER_RESPONSE'));
    scanner.poll();
    expect(agent().isWaiting).toBe(true);
    expect(agent().activeToolIds.size).toBe(0);
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_SYNTHETIC');
    expect(toPersistedAgent(agent())).toBeNull();
  });

  it('buffers split UTF-8, ignores malformed records and reads only appended bytes', () => {
    const target = file();
    const data = Buffer.from(record('USER_INPUT', { content: 'é' }));
    const split = data.indexOf(Buffer.from('é')) + 1;
    fs.appendFileSync(target, data.subarray(0, split));
    scanner.poll();
    expect(store.size).toBe(0);
    fs.appendFileSync(target, data.subarray(split));
    fs.appendFileSync(target, '{broken}\n');
    scanner.poll();
    expect(store.size).toBe(1);
    const count = agent().linesProcessed;
    scanner.poll();
    expect(agent().linesProcessed).toBe(count);
  });

  it('expires, resumes, finishes explicitly, and ignores historical sessions', () => {
    const target = file();
    fs.appendFileSync(target, event('USER_INPUT'));
    scanner.poll();
    now += 10001;
    scanner.poll();
    expect(store.size).toBe(0);
    fs.appendFileSync(target, event('USER_INPUT'));
    scanner.poll();
    expect(store.size).toBe(1);
    fs.appendFileSync(target, event('SESSION_END'));
    scanner.poll();
    expect(store.size).toBe(0);
    now += 10001;
    scanner.stop();
    scanner.poll();
    expect(store.size).toBe(0);
  });

  it('discovers two sessions and respects workspace scope and Watch All', () => {
    const first = file('first');
    const second = file('second', 'other');
    fs.appendFileSync(first, event('USER_INPUT'));
    fs.appendFileSync(second, event('USER_INPUT'));
    scanner.poll();
    expect(store.size).toBe(1);
    scanner.stop();
    scanner = new AntigravitySessionScanner(store, {
      roots: [root],
      workspaces: () => [],
      watchAll: () => true,
      now: () => now,
    });
    scanner.poll();
    expect([...store.values()].some((a) => a.sessionId === 'second')).toBe(true);
  });

  it('retries locked files and resets after truncation', () => {
    const target = file();
    fs.appendFileSync(target, event('USER_INPUT'));
    io.failOpen = true;
    scanner.poll();
    expect(store.size).toBe(0);
    scanner.poll();
    expect(store.size).toBe(1);
    fs.appendFileSync(target, record('GENERIC', { content: 'x'.repeat(2000) }));
    scanner.poll();
    fs.writeFileSync(target, event('USER_INPUT'));
    scanner.poll();
    expect(store.size).toBe(1);
  });

  it('bounds reads of huge malformed lines and recovers after their newline', () => {
    const target = file();
    fs.appendFileSync(target, 'x'.repeat(11 * 1024 * 1024) + '\n' + event('USER_INPUT'));
    for (let i = 0; i < 50; i++) scanner.poll();
    expect(store.size).toBe(1);
    expect(Math.max(...io.readLengths)).toBeLessThanOrEqual(AGY_READ_BYTES);
  });

  it('does not duplicate chunk mirrors or trust persistent presence files', () => {
    const target = file();
    const chunks = path.join(path.dirname(target), 'chunks', 'transcript');
    fs.mkdirSync(chunks, { recursive: true });
    fs.writeFileSync(path.join(chunks, '00000000.jsonl'), event('USER_INPUT'));
    fs.mkdirSync(path.join(root, 'presence'));
    fs.writeFileSync(path.join(root, 'presence', 'synthetic-session.lock'), '');
    scanner.poll();
    expect(store.size).toBe(0);
    fs.appendFileSync(target, event('USER_INPUT'));
    scanner.poll();
    expect(store.size).toBe(1);
    now += 10001;
    scanner.poll();
    expect(store.size).toBe(0);
  });

  it('preserves manual dismissal and stops polling', () => {
    vi.useFakeTimers();
    const target = file();
    fs.appendFileSync(target, event('USER_INPUT'));
    scanner.start();
    store.delete(agent().id);
    fs.appendFileSync(target, event('USER_INPUT'));
    scanner.poll();
    expect(store.size).toBe(0);
    scanner.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('keeps both conversations when the cache switches to a newer one in the same cwd', () => {
    const first = file('first');
    fs.appendFileSync(first, event('USER_INPUT'));
    scanner.poll();
    const second = file('second');
    fs.appendFileSync(second, event('USER_INPUT'));
    now += 3001;
    scanner.poll();
    fs.appendFileSync(first, record('PLANNER_RESPONSE', { tool_calls: [{ name: 'read_file' }] }));
    scanner.poll();
    expect(store.size).toBe(2);
    expect(
      [...store.values()]
        .find((a) => a.sessionId === 'first')
        ?.activeToolNames.values()
        .next().value,
    ).toBe('Read');
  });

  it('uses actual byte growth even with frozen Windows timestamps', () => {
    const target = file();
    const old = new Date(0);
    fs.utimesSync(target, old, old);
    fs.appendFileSync(target, event('USER_INPUT'));
    fs.utimesSync(target, old, old);
    scanner.poll();
    expect(store.size).toBe(1);
  });

  it('ends all calls at the next step and does not treat generic output as a new turn', () => {
    const target = file();
    fs.appendFileSync(
      target,
      record('PLANNER_RESPONSE', { tool_calls: [{ name: 'read_file' }, { name: 'write_file' }] }),
    );
    scanner.poll();
    expect(agent().activeToolIds.size).toBe(2);
    fs.appendFileSync(target, record('GENERIC', { content: 'PRIVATE_SYNTHETIC_OUTPUT' }));
    scanner.poll();
    expect(agent().activeToolIds.size).toBe(0);
    expect(agent().turnActive).toBe(true);
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_SYNTHETIC');
  });

  it('refuses to guess a cwd if the private metadata index is missing or broken', () => {
    const target = file();
    fs.writeFileSync(path.join(root, 'cache', 'last_conversations.json'), '{broken');
    fs.appendFileSync(target, event('USER_INPUT'));
    scanner.poll();
    expect(store.size).toBe(0);
  });
});
