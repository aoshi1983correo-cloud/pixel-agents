import * as fs from 'node:fs';
import * as path from 'node:path';

import type { OfficeArea } from '../../core/src/messages.js';

export interface OfficeAreas {
  areas: OfficeArea[];
  restArea: string;
  rules: { provider: string; pathPrefix?: string; area: string }[];
}

/** Explicit external configuration; never modifies a layout or exports directory rules. */
export function loadOfficeAreas(file: string | undefined): OfficeAreas | undefined {
  if (!file) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as OfficeAreas;
  if (!Array.isArray(raw.areas) || !Array.isArray(raw.rules))
    throw new Error('Invalid office areas');
  const names = new Set<string>();
  for (const area of raw.areas) {
    if (
      typeof area.name !== 'string' ||
      !area.name.trim() ||
      names.has(area.name) ||
      !Array.isArray(area.rectangles) ||
      !area.rectangles.length
    )
      throw new Error('Invalid office area');
    names.add(area.name);
    for (const r of area.rectangles) {
      if (
        ![r.col, r.row, r.width, r.height].every(Number.isSafeInteger) ||
        r.col < 0 ||
        r.row < 0 ||
        r.width <= 0 ||
        r.height <= 0
      )
        throw new Error('Invalid area rectangle');
    }
  }
  if (!names.has(raw.restArea)) throw new Error('Unknown rest area');
  for (const rule of raw.rules) {
    if (
      typeof rule.provider !== 'string' ||
      !names.has(rule.area) ||
      (rule.pathPrefix !== undefined && (typeof rule.pathPrefix !== 'string' || !rule.pathPrefix))
    )
      throw new Error('Invalid area rule');
  }
  return {
    areas: raw.areas.map(({ name, rectangles }) => ({
      name,
      rectangles: rectangles.map(({ col, row, width, height }) => ({ col, row, width, height })),
    })),
    restArea: raw.restArea,
    rules: raw.rules.map(({ provider, pathPrefix, area }) => ({
      provider,
      ...(pathPrefix === undefined ? {} : { pathPrefix }),
      area,
    })),
  };
}
function normalized(value: string): string {
  const windows = /^[a-z]:/i.test(value) || value.startsWith('\\\\') || value.startsWith('//');
  const slashes = (windows ? path.win32.normalize(value) : path.posix.normalize(value))
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  return /^[a-z]:/i.test(slashes) || slashes.startsWith('//') ? slashes.toLowerCase() : slashes;
}
/** First matching rule wins; prefixes respect directory boundaries. */
export function resolveOfficeArea(config: OfficeAreas, provider: string, cwd?: string): string {
  return (
    config.rules.find(
      (rule) =>
        rule.provider === provider &&
        (!rule.pathPrefix ||
          (cwd !== undefined &&
            (normalized(cwd) === normalized(rule.pathPrefix) ||
              normalized(cwd).startsWith(normalized(rule.pathPrefix) + '/')))),
    )?.area ?? config.restArea
  );
}
