import type { UsageLimits } from '../../../../../core/src/messages.js';
import type { AgentStateStore } from '../../../agentStateStore.js';
import { ELEVEN_BALANCE_MS, ELEVEN_REQUEST_TIMEOUT_MS } from './constants.js';

let latest: UsageLimits = { type: 'usageLimits', providerId: 'elevenlabs' };
export function elevenCreditsSnapshot(): UsageLimits {
  return { ...latest };
}
/** Server-only, single flight, no raw responses or errors cross the transport. */
export class ElevenLabsCredits {
  private timer?: ReturnType<typeof setInterval>;
  private lastAttempt = -Infinity;
  private controller?: AbortController;
  private stopped = false;
  constructor(
    private readonly store: AgentStateStore,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), ELEVEN_BALANCE_MS);
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
  async poll(): Promise<void> {
    if (this.stopped || this.controller || this.now() - this.lastAttempt < ELEVEN_BALANCE_MS)
      return;
    this.lastAttempt = this.now();
    latest = { type: 'usageLimits', providerId: 'elevenlabs' };
    const key = process.env.ELEVENLABS_API_KEY;
    if (key) {
      this.controller = new AbortController();
      const timer = setTimeout(() => this.controller?.abort(), ELEVEN_REQUEST_TIMEOUT_MS);
      try {
        const response = await this.request('https://api.elevenlabs.io/v1/user/subscription', {
          headers: { 'xi-api-key': key },
          signal: this.controller.signal,
          redirect: 'error',
        });
        if (response.ok) {
          const data = await response.json();
          if (
            [
              data.character_count,
              data.character_limit,
              data.next_character_count_reset_unix,
            ].every((v) => Number.isSafeInteger(v) && v >= 0) &&
            data.character_limit > 0
          )
            latest = {
              ...latest,
              updatedAt: this.now(),
              credits: {
                used: data.character_count,
                limit: data.character_limit,
                renewsAt: data.next_character_count_reset_unix,
              },
            };
        }
      } catch {
        /* Only disconnected state; never log credentials, bodies or exceptions. */
      } finally {
        clearTimeout(timer);
        this.controller = undefined;
      }
    }
    if (!this.stopped) this.store.broadcast({ ...latest });
  }
}
