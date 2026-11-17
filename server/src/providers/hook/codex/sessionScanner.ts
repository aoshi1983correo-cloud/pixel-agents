import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { AgentEvent } from '../../../../../core/src/provider.js';
import { createAgentState } from '../../../agentState.js';
import type { AgentStateStore } from '../../../agentStateStore.js';
import { assignPaletteIfNeeded } from '../../../paletteAssigner.js';
import { pathsMatch } from '../../../pathKey.js';
import type { AgentState } from '../../../types.js';
import { codexProvider, object, parseRecord } from './codex.js';
import {
  CODEX_DISCOVERY_MS,
  CODEX_IDLE_MS,
  CODEX_MAX_LINE_CHARS,
  CODEX_POLL_MS,
  CODEX_READ_BYTES,
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
  dismissed: boolean;
}

export interface CodexScannerOptions {
  roots?: string[];
  workspaces: () => string[];
  watchAll: () => boolean;
  idleMs?: number;
  now?: () => number;
}

/** Date-sharded discovery and bounded incremental reads. Every descriptor is opened read-only. */
export class CodexSessionScanner {
  private readonly cursors = new Map<string, Cursor>();
  private timer?: ReturnType<typeof setInterval>;
  private discoveredAt = -Infinity;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: AgentStateStore,
    private readonly options: CodexScannerOptions,
  ) {
    const configured = Number(process.env.PIXEL_AGENTS_CODEX_IDLE_MS);
    this.idleMs =
      options.idleMs ??
      (Number.isFinite(configured) && configured > 0 ? configured : CODEX_IDLE_MS);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), CODEX_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.cursors.clear();
    this.discoveredAt = -Infinity;
  }

  poll(): void {
    const now = this.now();
    if (now - this.discoveredAt >= CODEX_DISCOVERY_MS) {
      this.discoveredAt = now;
      for (const root of this.options.roots ?? codexProvider.getAllSessionRoots!())
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

  private discover(dir: string, depth = 0): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        // No symlink traversal; root/year/month/day only.
        if (entry.isDirectory() && depth < 3) this.discover(file, depth + 1);
        else if (
          entry.isFile() &&
          /^rollout-.*\.jsonl$/.test(entry.name) &&
          !this.cursors.has(file)
        ) {
          this.cursors.set(file, {
            offset: 0,
            decoder: new StringDecoder('utf8'),
            pending: '',
            discard: false,
            lastData: 0,
            dismissed: false,
          });
        }
      }
    } catch {
      /* Missing dates, temporary locks and permission failures are retried. */
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
          sessionId: undefined,
          cwd: undefined,
          dismissed: false,
        });
      }
      if (size <= cursor.offset) return;
      const buffer = Buffer.alloc(Math.min(CODEX_READ_BYTES, size - cursor.offset));
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
          if (cursor.pending.length > CODEX_MAX_LINE_CHARS) {
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
    const payload = object(record.payload);
    if (record.type === 'session_meta') {
      const id = payload.id ?? payload.session_id;
      if (typeof id === 'string') cursor.sessionId = id;
      if (typeof payload.cwd === 'string') cursor.cwd = payload.cwd;
    }
    if (record.type === 'turn_context' && typeof payload.cwd === 'string') cursor.cwd = payload.cwd;
    const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
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
        providerId: codexProvider.id,
        hookDelivered: true,
        directoryName: `Codex · ${path.basename(cursor.cwd)}`,
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
    // last_token_usage is occupancy; total_token_usage is cumulative spend, never a gauge.
    const info = object(payload.info);
    const usage = object(info.last_token_usage);
    const tokens = usage.total_tokens;
    const window = info.model_context_window;
    if (
      typeof tokens === 'number' &&
      Number.isFinite(tokens) &&
      tokens >= 0 &&
      typeof window === 'number' &&
      Number.isFinite(window) &&
      window > 0
    ) {
      agent.contextTokens = tokens;
      agent.maxContextTokens = window;
      agent.contextReported = true;
      this.store.broadcast({
        type: 'agentContextUsage',
        id: agent.id,
        contextTokens: tokens,
        maxContextTokens: window,
      });
    }
  }

  private apply(agent: AgentState, event: AgentEvent): void {
    const id = agent.id;
    if (event.kind === 'toolStart') {
      // Thinking is a turn activity, not a tool that can remain stuck beside real calls.
      if (event.toolId !== 'codex-thinking') this.endTool(agent, 'codex-thinking');
      agent.isWaiting = false;
      agent.turnActive = true;
      if (agent.permissionSent) this.store.broadcast({ type: 'agentToolPermissionClear', id });
      agent.permissionSent = false;
      const status = codexProvider.formatToolStatus(event.toolName);
      const name = codexProvider.readingTools.has(event.toolName) ? 'Read' : event.toolName;
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
