import {
  CONTEXT_GAUGE_COLOR_YELLOW,
  USAGE_BARS_LEFT_PX,
  USAGE_PROVIDER_ROW_HEIGHT_PX,
} from '../constants.js';
import { useUsageBridge } from './useUsageBridge.js';

export function ElevenCredits({ mobile }: { mobile: boolean }) {
  const { limits } = useUsageBridge(undefined, 'elevenlabs');
  const c = limits?.credits;
  const ratio = c ? c.used / c.limit : undefined;
  const color =
    ratio === undefined
      ? 'var(--color-border)'
      : ratio > 0.9
        ? 'var(--color-danger)'
        : ratio >= 0.7
          ? CONTEXT_GAUGE_COLOR_YELLOW
          : 'var(--color-status-success)';
  const text = c
    ? `ElevenLabs: ${String(c.used).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} / ${String(c.limit).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} · se renueva el ${new Date(c.renewsAt * 1000).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}`
    : 'ElevenLabs: sin conexión';
  return (
    <div
      className={`absolute z-10 bg-bg-dark border-2 text-2xs text-text px-4 py-2 ${mobile ? 'mobile-safe-top' : 'top-8'}`}
      style={{
        left: USAGE_BARS_LEFT_PX,
        marginTop: 3 * USAGE_PROVIDER_ROW_HEIGHT_PX,
        borderColor: color,
      }}
      title="Créditos usados / límite de ElevenLabs. Consulta cada 10 minutos."
    >
      {text}
    </div>
  );
}
