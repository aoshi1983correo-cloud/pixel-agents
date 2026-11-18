import type { ReportedUsage } from '../../../../../core/src/provider.js';
import { object } from './codex.js';

const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10080;
/** Window duration, not primary/secondary order, determines the label. */
export function codexRateLimits(raw: unknown): ReportedUsage | null {
  const report = object(raw);
  if (report.limit_id !== undefined && report.limit_id !== null && report.limit_id !== 'codex')
    return null;
  const result: ReportedUsage = {};
  for (const value of [report.primary, report.secondary]) {
    const window = object(value);
    const used = window.used_percent,
      reset = window.resets_at;
    if (
      typeof used !== 'number' ||
      !Number.isFinite(used) ||
      used < 0 ||
      typeof reset !== 'number' ||
      !Number.isFinite(reset) ||
      reset <= 0
    )
      continue;
    const key =
      window.window_minutes === FIVE_HOUR_MINUTES
        ? 'fiveHour'
        : window.window_minutes === SEVEN_DAY_MINUTES
          ? 'sevenDay'
          : undefined;
    if (key) result[key] = { usedPercentage: used, resetsAt: reset };
  }
  return result.fiveHour || result.sevenDay ? result : null;
}
