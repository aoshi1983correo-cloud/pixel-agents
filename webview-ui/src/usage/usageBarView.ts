/**
 * What the usage bars show, from the last `usageLimits` the server sent. Pure
 * (no DOM, no clock of its own), so the rules are Node-tested.
 *
 * Reports only arrive while a Claude Code session is open, so the numbers can
 * be old. Expired windows are unknown until another measured report arrives;
 * the age of every retained report remains visible.
 */

import type { UsageWindow } from '../../../core/src/messages.js';
import {
  USAGE_BAR_LOW_FRACTION,
  USAGE_BAR_WARN_FRACTION,
  USAGE_HEART_MAX_BPM,
} from '../constants.js';

/** How full a bar reads, which colour band it is in, and what it says. */
export interface UsageBarView {
  /** Share of the window LEFT, 0-1. Null when nothing is known. */
  remaining: number | null;
  level: 'ok' | 'warn' | 'low' | 'unknown';
  /** Shown beside the bar: "73%", or "--" when nothing is known. */
  percent: string;
  /** Shown on hover: "resets in 2h 14m", or why there is no time. */
  reset: string;
}

/** One bar's view of a window at `nowMs`. */
export function usageBarView(window: UsageWindow | undefined, nowMs: number): UsageBarView {
  if (
    !window ||
    !Number.isFinite(window.usedPercentage) ||
    window.usedPercentage < 0 ||
    !Number.isFinite(window.resetsAt)
  )
    return { remaining: null, level: 'unknown', percent: 'sin datos', reset: 'sin datos' };
  const resetAtMs = window.resetsAt * 1000;
  if (resetAtMs <= nowMs) {
    return { remaining: null, level: 'unknown', percent: 'sin datos', reset: 'lectura caducada' };
  }
  const remaining = Math.min(1, Math.max(0, (100 - window.usedPercentage) / 100));
  const level =
    window.usedPercentage >= (1 - USAGE_BAR_LOW_FRACTION) * 100
      ? 'low'
      : window.usedPercentage >= (1 - USAGE_BAR_WARN_FRACTION) * 100
        ? 'warn'
        : 'ok';
  return {
    remaining,
    level,
    percent: `${Math.round(remaining * 100)}%`,
    reset: `resets in ${formatDuration(resetAtMs - nowMs)}`,
  };
}

/** Seconds per heartbeat for a share left: the pace is proportional to it
 *  (a full plan beats at USAGE_HEART_MAX_BPM), and an empty or unknown plan
 *  has no beat at all (null). */
export function heartBeatPeriodSec(remaining: number | null): number | null {
  if (remaining === null || remaining <= 0) return null;
  return 60 / (USAGE_HEART_MAX_BPM * remaining);
}

/** "3d 4h", "2h 14m", "9m", "<1m" — the two largest units. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** "updated just now" / "updated 12m ago", or the hint for no report at all
 *  (`providerName`: whose sessions report it). */
export function freshnessLabel(
  updatedAtMs: number | undefined,
  nowMs: number,
  providerName: string,
): string {
  if (updatedAtMs === undefined) return `${providerName}: sin datos`;
  const age = nowMs - updatedAtMs;
  return age < 60_000 ? 'Updated just now' : `Updated ${formatDuration(age)} ago`;
}
