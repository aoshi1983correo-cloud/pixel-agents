import { describe, expect, it } from 'vitest';

import { codexRateLimits } from '../src/providers/hook/codex/rateLimits.js';

describe('Codex reported plan limits (synthetic)', () => {
  const window = (minutes: number, used = 62) => ({
    window_minutes: minutes,
    used_percent: used,
    resets_at: 1900000000,
  });
  it('identifies 5-hour and weekly windows by duration even in reversed order', () => {
    expect(
      codexRateLimits({ limit_id: 'codex', primary: window(10080, 91), secondary: window(300) }),
    ).toEqual({
      fiveHour: { usedPercentage: 62, resetsAt: 1900000000 },
      sevenDay: { usedPercentage: 91, resetsAt: 1900000000 },
    });
  });
  it('keeps absent data unknown, rejects malformed windows and other model buckets', () => {
    for (const value of [
      undefined,
      {},
      { primary: window(60) },
      { primary: window(300, NaN) },
      { primary: { ...window(300), resets_at: null } },
      { limit_id: 'other-model', primary: window(300) },
    ])
      expect(codexRateLimits(value)).toBeNull();
    expect(codexRateLimits({ primary: window(300, 0) })).toHaveProperty(
      'fiveHour.usedPercentage',
      0,
    );
  });
});
