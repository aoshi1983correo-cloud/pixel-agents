import * as path from 'node:path';

import type { HookProvider } from '../../../../../core/src/provider.js';
import { antigravityProvider } from '../antigravity/antigravity.js';

/** External activity only: never installs hooks or launches a paid request. */
export const elevenlabsProvider: HookProvider = {
  ...antigravityProvider,
  id: 'elevenlabs',
  displayName: 'ElevenLabs',
  getAllSessionRoots: () => [],
  parseTranscriptLine: () => null,
  formatToolStatus: () => 'Trabajando con audio',
  consentDisclosure: () => ({
    headline: 'ElevenLabs',
    disclosure: 'Registro local de solo lectura.',
  }),
};

export function elevenLogPath(): string | undefined {
  return (
    process.env.PIXEL_AGENTS_ELEVEN_LOG ||
    (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'soultrip', 'eleven', 'actividad.jsonl')
      : undefined)
  );
}
