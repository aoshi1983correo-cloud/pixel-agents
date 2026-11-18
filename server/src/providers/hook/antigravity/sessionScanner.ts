import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { AgentEvent } from '../../../../../core/src/provider.js';
import { createAgentState } from '../../../agentState.js';
import type { AgentStateStore } from '../../../agentStateStore.js';
import { assignPaletteIfNeeded } from '../../../paletteAssigner.js';
import { pathsMatch } from '../../../pathKey.js';
import type { AgentState } from '../../../types.js';
import { antigravityProvider, object, parseRecord } from './antigravity.js';
import {
  AGY_DISCOVERY_MS,
  AGY_IDLE_MS,
  AGY_MAX_LINE_CHARS,
  AGY_POLL_MS,
  AGY_READ_BYTES,
} from './constants.js';

interface Cursor {
  offset: number;
  decoder: StringDecoder;
  pending: string;
  discard: boolean;
  sessionId?: string;
  cwd?: string;
  agentId?: number;
  lastData: number;
  step?: number;
  dismissed: boolean;
}

export interface AntigravityScannerOptions {
  roots?: string[];
  cwdForSession?: (id: string) => string | undefined;
  workspaces: () => string[];
  watchAll: () => boolean;
  idleMs?: number;
  now?: () => number;
}

/** Bounded incremental reads of Antigravity transcripts; no account files are written. */
export class AntigravitySessionScanner {
  private readonly cursors = new Map<string, Cursor>();
  private timer?: ReturnType<typeof setInterval>;
  private discoveredAt = -Infinity;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: AgentStateStore,
    private readonly options: AntigravityScannerOptions,
  ) {
    const configured = Number(process.env.PIXEL_AGENTS_AGY_IDLE_MS);
    this.idleMs =
      options.idleMs ?? (Number.isFinite(configured) && configured > 0 ? configured : AGY_IDLE_MS);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), AGY_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.cursors.clear();
    this.discoveredAt = -Infinity;
  }

  poll(): void {
    const now = this.now();
    if (now - this.discoveredAt >= AGY_DISCOVERY_MS) {
      this.discoveredAt = now;
      for (const root of this.options.roots ?? antigravityProvider.getAllSessionRoots!())
        this.discover(root);
    }
    for (const [file, cursor] of this.cursors) {
      if (cursor.agentId !== undefined && cursor.cwd && !this.inScope(cursor.cwd))
        this.remove(cursor);
      this.read(file, cursor, now);
      if (cursor.agentId !== undefined && now - cursor.lastData >= this.idleMs) {
        this.remove(cursor);
      }
    }
  }

  private inScope(cwd: string): boolean {
    return (
      this.options.watchAll() ||
      this.options.workspaces().some((workspace) => pathsMatch(workspace, cwd))
    );
  }

  private discover(root: string): void {
    try {
      for (const entry of fs.readdirSync(path.join(root, 'brain'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(
          root,
          'brain',
          entry.name,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );
        if (this.cursors.has(file)) continue;
        this.cursors.set(file, {
          offset: 0,
          decoder: new StringDecoder('utf8'),
          pending: '',
          discard: false,
          lastData: 0,
          dismissed: false,
          sessionId: entry.name,
        });
      }
    } catch {
      /* Missing roots and locks are retried without logging private paths. */
    }
  }

  private cwdFor(file: string, id: string): string | undefined {
    if (this.options.cwdForSession) return this.options.cwdForSession(id);
    try {
      const root = path.resolve(path.dirname(file), '../../../..');
      const index = object(
        JSON.parse(fs.readFileSync(path.join(root, 'cache', 'last_conversations.json'), 'utf8')),
      );
      return Object.keys(index).find((cwd) => index[cwd] === id);
    } catch {
      return undefined;
    }
  }

  private read(file: string, cursor: Cursor, now: number): void {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size; // Directory LastWriteTime is stale on Windows.
      if (size < cursor.offset) {
        this.remove(cursor);
        Object.assign(cursor, {
          offset: 0,
          pending: '',
          discard: false,
          decoder: new StringDecoder('utf8'),
          step: undefined,
          cwd: undefined,
          dismissed: false,
        });
      }
      if (size <= cursor.offset) return;
      const buffer = Buffer.alloc(Math.min(AGY_READ_BYTES, size - cursor.offset));
      const count = fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
      if (!count) return;
      cursor.offset += count;
      const text = cursor.decoder.write(buffer.subarray(0, count));
      // Split before joining so a gigantic unterminated record cannot grow memory indefinitely.
      const fragments = text.split('\n');
      for (let index = 0; index < fragments.length; index++) {
        const fragment = fragments[index];
        if (!cursor.discard) {
          cursor.pending += fragment;
          if (cursor.pending.length > AGY_MAX_LINE_CHARS) {
            cursor.pending = '';
            cursor.discard = true;
          }
        }
        if (index < fragments.length - 1) {
          if (!cursor.discard) this.line(file, cursor, cursor.pending, now);
          cursor.pending = '';
          cursor.discard = false;
        }
      }
    } catch {
      /* Never advance on a failed open/read; retry the same offset. */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private line(file: string, cursor: Cursor, line: string, now: number): void {
    let record: Record<string, unknown>;
    try {
      record = object(JSON.parse(line));
    } catch {
      return;
    }
    // The CLI cache holds only the newest conversation per cwd. Preserve a mapping
    // already observed when a second conversation starts in that same directory.
    cursor.cwd = this.cwdFor(file, cursor.sessionId!) ?? cursor.cwd;
    const timestamp = typeof record.created_at === 'string' ? Date.parse(record.created_at) : NaN;
    // Old history must never resurrect dead agents. Appends without a timestamp are accepted
    // only after identity was established by a recent, timestamped event.
    if (
      Number.isFinite(timestamp)
        ? now - timestamp >= this.idleMs || timestamp > now + this.idleMs
        : !cursor.lastData
    )
      return;
    cursor.lastData = Number.isFinite(timestamp) ? Math.min(timestamp, now) : now;
    const event = parseRecord(record);
    if (typeof record.step_index === 'number' && cursor.step !== record.step_index) {
      const previous = cursor.agentId === undefined ? undefined : this.store.get(cursor.agentId);
      if (previous) for (const tool of [...previous.activeToolIds]) this.endTool(previous, tool);
      cursor.step = record.step_index;
    }
    if (event?.kind === 'sessionEnd') {
      this.remove(cursor);
      return;
    }
    if (event?.kind === 'sessionStart') return;
    if (!cursor.cwd || !cursor.sessionId || cursor.dismissed) return;
    if (!this.inScope(cursor.cwd)) return;
    if (cursor.agentId !== undefined && !this.store.has(cursor.agentId)) {
      cursor.agentId = undefined;
      cursor.dismissed = true;
      return;
    }
    if (cursor.agentId === undefined && event) {
      const id = this.store.nextAgentId.current++;
      const agent = createAgentState({
        id,
        sessionId: cursor.sessionId,
        projectDir: path.dirname(file),
        jsonlFile: file,
        isExternal: true,
        providerId: antigravityProvider.id,
        hookDelivered: true,
        directoryName: `Antigravity · ${path.basename(cursor.cwd)}`,
      });
      assignPaletteIfNeeded(agent, this.store);
      this.store.set(id, agent);
      cursor.agentId = id;
    }
    const agent = cursor.agentId === undefined ? undefined : this.store.get(cursor.agentId);
    if (!agent) return;
    agent.lastDataAt = cursor.lastData;
    agent.fileOffset = cursor.offset;
    agent.linesProcessed++;
    if (event) this.apply(agent, event);
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    for (const [index, call] of calls.entries()) {
      const name = object(call).name;
      if (typeof name === 'string')
        this.apply(agent, {
          kind: 'toolStart',
          toolId: `${record.step_index}:${index}`,
          toolName: name,
        });
    }
  }

  private apply(agent: AgentState, event: AgentEvent): void {
    const id = agent.id;
    if (event.kind === 'toolStart') {
      // Thinking is a turn activity, not a tool that can remain stuck beside real calls.
      if (event.toolId !== 'antigravity-thinking') this.endTool(agent, 'antigravity-thinking');
      agent.isWaiting = false;
      agent.turnActive = true;
      if (agent.permissionSent) this.store.broadcast({ type: 'agentToolPermissionClear', id });
      agent.permissionSent = false;
      const status = antigravityProvider.formatToolStatus(event.toolName);
      const name = antigravityProvider.readingTools.has(event.toolName) ? 'Read' : event.toolName;
      if (!agent.activeToolIds.has(event.toolId)) {
        agent.activeToolIds.add(event.toolId);
        agent.activeToolNames.set(event.toolId, name);
        agent.activeToolStatuses.set(event.toolId, status);
        this.store.broadcast({
          type: 'agentToolStart',
          id,
          toolId: event.toolId,
          toolName: name,
          status,
        });
      }
      this.store.broadcast({ type: 'agentStatus', id, status: 'active' });
    } else if (event.kind === 'toolEnd') {
      this.endTool(agent, event.toolId);
    } else if (event.kind === 'permissionRequest' || event.kind === 'turnEnd') {
      agent.isWaiting = true;
      agent.turnActive = false;
      agent.permissionSent = event.kind === 'permissionRequest';
      if (event.kind === 'turnEnd') {
        agent.activeToolIds.clear();
        agent.activeToolNames.clear();
        agent.activeToolStatuses.clear();
        this.store.broadcast({ type: 'agentToolsClear', id });
      }
      this.store.broadcast({
        type: 'agentStatus',
        id,
        status: 'waiting',
        awaitingInput: event.kind === 'permissionRequest' || event.awaitingInput === true,
      });
      // Send after agentStatus: showWaitingBubble would otherwise replace the approval bubble.
      if (event.kind === 'permissionRequest')
        this.store.broadcast({ type: 'agentToolPermission', id });
    }
  }

  private endTool(agent: AgentState, toolId: string): void {
    if (!agent.activeToolIds.delete(toolId)) return;
    agent.activeToolNames.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    this.store.broadcast({ type: 'agentToolDone', id: agent.id, toolId });
  }

  private remove(cursor: Cursor): void {
    if (cursor.agentId === undefined) return;
    const id = cursor.agentId;
    this.store.delete(id);
    cursor.agentId = undefined;
  }
}
