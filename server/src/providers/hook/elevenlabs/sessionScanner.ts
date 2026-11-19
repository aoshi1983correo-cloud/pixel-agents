import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createAgentState } from '../../../agentState.js';
import type { AgentStateStore } from '../../../agentStateStore.js';
import { assignPaletteIfNeeded } from '../../../paletteAssigner.js';
import {
  ELEVEN_DONE_MS,
  ELEVEN_MAX_JOBS,
  ELEVEN_MAX_LINE,
  ELEVEN_POLL_MS,
  ELEVEN_READ_BYTES,
  ELEVEN_STUCK_MS,
} from './constants.js';
import { elevenLogPath } from './elevenlabs.js';

interface Job {
  id: string;
  ts: number;
  state: 'inicio' | 'fin' | 'error';
  label: string;
}
const verbs: Record<string, string> = {
  saldo: 'Consultando saldo',
  voz: 'Generando voz',
  transcribir: 'Transcribiendo',
  alinear: 'Alineando',
  efecto: 'Creando efecto',
  limpiar: 'Limpiando audio',
};
const callers: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity',
  manual: 'manual',
};

/** Bounded incremental reader, one shared character even for concurrent callers. */
export class ElevenLabsSessionScanner {
  private timer?: ReturnType<typeof setInterval>;
  private offset = 0;
  private identity = '';
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private discard = false;
  private jobs = new Map<string, Job>();
  private agentId?: number;
  private lastView = '';
  constructor(
    private readonly store: AgentStateStore,
    private readonly file = elevenLogPath(),
    private readonly now: () => number = Date.now,
  ) {}
  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), ELEVEN_POLL_MS);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.jobs.clear();
  }
  poll(): void {
    if (!this.file) return;
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (identity !== this.identity || stat.size < this.offset) {
        this.identity = identity;
        this.offset = 0;
        this.pending = '';
        this.discard = false;
        this.decoder = new StringDecoder('utf8');
      }
      const buffer = Buffer.alloc(
        Math.min(ELEVEN_READ_BYTES, Math.max(0, stat.size - this.offset)),
      );
      const count = buffer.length ? fs.readSync(fd, buffer, 0, buffer.length, this.offset) : 0;
      this.offset += count;
      const fragments = this.decoder.write(buffer.subarray(0, count)).split('\n');
      for (let i = 0; i < fragments.length; i++) {
        if (!this.discard) {
          this.pending += fragments[i];
          if (this.pending.length > ELEVEN_MAX_LINE) {
            this.pending = '';
            this.discard = true;
          }
        }
        if (i < fragments.length - 1) {
          if (!this.discard) this.line(this.pending);
          this.pending = '';
          this.discard = false;
        }
      }
    } catch {
      /* Absent/locked log is retried without exposing file paths. */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    this.render();
  }
  private line(line: string): void {
    try {
      const e = JSON.parse(line);
      const ts = Date.parse(e.ts);
      if (
        typeof e.id !== 'string' ||
        !/^[a-z\d-]{1,64}$/i.test(e.id) ||
        !Number.isFinite(ts) ||
        ts > this.now() + ELEVEN_POLL_MS ||
        !['inicio', 'fin', 'error'].includes(e.estado) ||
        !Object.hasOwn(verbs, e.accion)
      )
        return;
      const detail =
        typeof e.detalle === 'string'
          ? path.win32
              .basename(e.detalle.replace(/\//g, '\\'))
              .replace(/[\r\n\x00-\x1f]/g, '')
              .slice(0, 100)
              .replace(/sk_[\w-]+/g, '[privado]')
          : '';
      const previous = this.jobs.get(e.id);
      if (previous && previous.ts > ts) return;
      this.jobs.delete(e.id);
      this.jobs.set(e.id, {
        id: e.id,
        ts,
        state: e.estado,
        label: `${verbs[e.accion]}${detail ? ' ' + detail : ''} · pide ${callers[e.pide] || 'manual'}`,
      });
      if (this.jobs.size > ELEVEN_MAX_JOBS) this.jobs.delete(this.jobs.keys().next().value!);
    } catch {
      /* Malformed records never reach the office. */
    }
  }
  private render(): void {
    const now = this.now();
    for (const job of this.jobs.values())
      if (job.state === 'inicio' && now - job.ts > ELEVEN_STUCK_MS) {
        job.state = 'error';
        job.ts = now;
        job.label = 'Error: operación sin finalizar (más de 15 min)';
      }
    const jobs = [...this.jobs.values()].reverse();
    const job =
      jobs.filter((j) => j.state === 'inicio').sort((a, b) => b.ts - a.ts)[0] ??
      jobs.sort((a, b) => b.ts - a.ts)[0];
    if (!job || (this.agentId === undefined && now - job.ts > ELEVEN_DONE_MS)) return;
    const expired = job.state !== 'inicio' && now - job.ts > ELEVEN_DONE_MS;
    const view = `${job.id}:${job.state}:${expired}`;
    if (this.agentId !== undefined && !this.store.has(this.agentId)) return; // Dismissed means dismissed.
    if (this.lastView === view) return;
    this.lastView = view;
    if (this.agentId === undefined) {
      this.agentId = this.store.nextAgentId.current++;
      const agent = createAgentState({
        id: this.agentId,
        sessionId: 'elevenlabs-local',
        projectDir: '',
        jsonlFile: this.file || '',
        providerId: 'elevenlabs',
        isExternal: true,
        hookDelivered: true,
        directoryName: 'ElevenLabs',
      });
      assignPaletteIfNeeded(agent, this.store);
      this.store.set(agent.id, agent);
    }
    const id = this.agentId,
      agent = this.store.get(id)!;
    agent.activeToolIds.clear();
    agent.activeToolNames.clear();
    agent.activeToolStatuses.clear();
    this.store.broadcast({ type: 'agentToolsClear', id });
    agent.officeStayUntil = job.state === 'fin' ? job.ts + ELEVEN_DONE_MS : 0;
    agent.lastDataAt = now;
    agent.isWaiting = job.state !== 'inicio';
    agent.turnActive = !agent.isWaiting;
    if (!expired && job.state !== 'fin') {
      const status =
        job.state === 'error'
          ? job.label.startsWith('Error:')
            ? job.label
            : 'Error de ElevenLabs · ' + job.label
          : job.label;
      agent.activeToolIds.add(job.id);
      agent.activeToolNames.set(job.id, 'Audio');
      agent.activeToolStatuses.set(job.id, status);
      this.store.broadcast({
        type: 'agentToolStart',
        id,
        toolId: job.id,
        toolName: 'Audio',
        status,
      });
    }
    this.store.broadcast({
      type: 'agentStatus',
      id,
      status: agent.isWaiting ? 'waiting' : 'active',
      awaitingInput: !expired && job.state === 'error',
    });
  }
}
