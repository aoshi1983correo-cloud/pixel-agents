import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toPersistedAgent } from '../src/agentPersistence.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  ELEVEN_BALANCE_MS,
  ELEVEN_DONE_MS,
  ELEVEN_STUCK_MS,
} from '../src/providers/hook/elevenlabs/constants.js';
import {
  elevenCreditsSnapshot,
  ElevenLabsCredits,
} from '../src/providers/hook/elevenlabs/credits.js';
import { ElevenLabsSessionScanner } from '../src/providers/hook/elevenlabs/sessionScanner.js';

describe('ElevenLabs local activity and server-only subscription (invented data)', () => {
  let root: string,
    file: string,
    store: AgentStateStore,
    scanner: ElevenLabsSessionScanner,
    now: number,
    messages: Record<string, unknown>[];
  const agent = () => [...store.values()][0];
  function append(estado: string, id = 'synthetic', offset = 0, extra = {}) {
    fs.appendFileSync(
      file,
      JSON.stringify({
        ts: new Date(now + offset).toISOString(),
        id,
        estado,
        accion: 'transcribir',
        pide: 'codex',
        detalle: 'inventado.mp4',
        ...extra,
      }) + '\n',
    );
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-synthetic-'));
    file = path.join(root, 'activity.jsonl');
    store = new AgentStateStore();
    now = Date.now();
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
    scanner = new ElevenLabsSessionScanner(store, file, () => now);
  });
  afterEach(() => {
    scanner.stop();
    store.dispose();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('ignores missing logs, malformed records, partial lines and old completed jobs', () => {
    scanner.poll();
    expect(store.size).toBe(0);
    append('fin', 'old', -ELEVEN_DONE_MS - 1);
    fs.appendFileSync(file, 'bad\n{"id":');
    scanner.poll();
    expect(store.size).toBe(0);
  });
  it('adopts working audio, keeps safe labels and handles finish with a short seat grace period', () => {
    append('inicio', 'synthetic', 0, {
      detalle: 'C:\\invented\\inventado.mp4',
      text: 'PRIVATE_SYNTHETIC',
    });
    scanner.poll();
    expect(agent().providerId).toBe('elevenlabs');
    expect(agent().turnActive).toBe(true);
    expect(toPersistedAgent(agent())).toBeNull();
    expect(JSON.stringify(messages)).toContain('Transcribiendo inventado.mp4 · pide Codex');
    expect(JSON.stringify(messages)).not.toMatch(/PRIVATE_SYNTHETIC|invented/);
    append('fin');
    scanner.poll();
    expect(agent().isWaiting).toBe(true);
    expect(agent().officeStayUntil).toBe(now + ELEVEN_DONE_MS);
    now += ELEVEN_DONE_MS + 1;
    scanner.poll();
    expect(agent().activeToolIds.size).toBe(0);
  });
  it('marks errors and starts older than fifteen minutes visibly', () => {
    append('inicio', 'stuck', -ELEVEN_STUCK_MS - 1);
    scanner.poll();
    expect(JSON.stringify(messages)).toContain('más de 15 min');
    expect(agent().isWaiting).toBe(true);
    append('error', 'failed');
    scanner.poll();
    expect(JSON.stringify(messages)).toContain('Error de ElevenLabs');
  });
  it('keeps another concurrent operation working when the newest finishes, survives rotation and respects dismissal', () => {
    append('inicio', 'first');
    scanner.poll();
    append('inicio', 'second');
    append('fin', 'second');
    scanner.poll();
    expect(agent().turnActive).toBe(true);
    fs.renameSync(file, file + '.1');
    append('fin', 'first');
    scanner.poll();
    expect(agent().isWaiting).toBe(true);
    store.delete(agent().id);
    append('inicio', 'third');
    scanner.poll();
    expect(store.size).toBe(0);
  });
  it('bounds oversized lines and handles truncation', () => {
    fs.writeFileSync(file, 'x'.repeat(300000) + '\n');
    scanner.poll();
    scanner.poll();
    expect(store.size).toBe(0);
    fs.writeFileSync(file, '');
    append('inicio');
    scanner.poll();
    expect(store.size).toBe(1);
  });
  it('only emits numeric credit fields; throttles attempts including failures and concurrent polls', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'synthetic-private-key');
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            character_count: 1234,
            character_limit: 39769,
            next_character_count_reset_unix: 1800000000,
            private: 'DO_NOT_SEND',
          }),
        ),
    );
    const credits = new ElevenLabsCredits(store, request, () => now);
    await Promise.all([credits.poll(), credits.poll()]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(elevenCreditsSnapshot()).toMatchObject({
      credits: { used: 1234, limit: 39769, renewsAt: 1800000000 },
    });
    expect(JSON.stringify(messages)).not.toMatch(/synthetic-private-key|DO_NOT_SEND/);
    now += ELEVEN_BALANCE_MS;
    request.mockRejectedValueOnce(new Error('synthetic-private-key'));
    await credits.poll();
    expect(elevenCreditsSnapshot().credits).toBeUndefined();
    await credits.poll();
    expect(request).toHaveBeenCalledTimes(2);
    credits.stop();
  });
  it('degrades without credentials and rejects invalid balances', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    const request = vi.fn(async () => new Response('{}'));
    const credits = new ElevenLabsCredits(store, request, () => now);
    await credits.poll();
    expect(request).not.toHaveBeenCalled();
    expect(elevenCreditsSnapshot().credits).toBeUndefined();
    vi.stubEnv('ELEVENLABS_API_KEY', 'synthetic');
    now += ELEVEN_BALANCE_MS;
    await credits.poll();
    expect(elevenCreditsSnapshot().credits).toBeUndefined();
    credits.stop();
  });
});
