import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { loadOfficeAreas, type OfficeAreas, resolveOfficeArea } from '../src/officeAreas.js';

const config: OfficeAreas = {
  areas: ['Studio', 'Programs', 'Lounge'].map((name) => ({
    name,
    rectangles: [{ col: 1, row: 1, width: 5, height: 4 }],
  })),
  restArea: 'Lounge',
  rules: [
    { provider: 'codex', pathPrefix: 'C:/Projects/site', area: 'Studio' },
    { provider: 'codex', area: 'Programs' },
    { provider: 'claude', area: 'Studio' },
    { provider: 'antigravity', area: 'Programs' },
  ],
};
describe('external office areas (invented directories)', () => {
  it('matches Windows prefixes case-insensitively and on directory boundaries', () => {
    expect(resolveOfficeArea(config, 'codex', 'c:\\PROJECTS\\site\\src')).toBe('Studio');
    expect(resolveOfficeArea(config, 'codex', 'C:/Projects/site-other')).toBe('Programs');
    expect(resolveOfficeArea(config, 'codex', '/elsewhere')).toBe('Programs');
    expect(resolveOfficeArea(config, 'claude')).toBe('Studio');
    expect(resolveOfficeArea(config, 'antigravity')).toBe('Programs');
    expect(resolveOfficeArea(config, 'other')).toBe('Lounge');
  });
  it('has no configuration or routing messages unless explicitly enabled', () => {
    expect(loadOfficeAreas(undefined)).toBeUndefined();
    expect(new AgentStateStore().officeAreaMessages()).toEqual([]);
  });
  it('rejects invalid geometry and unknown rule destinations; sends no directory rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areas-synthetic-'));
    const file = path.join(root, 'areas.json');
    try {
      fs.writeFileSync(file, JSON.stringify(config));
      const store = new AgentStateStore();
      store.configureOfficeAreas(file);
      const agent = createAgentState({
        id: 1,
        sessionId: 'fake',
        projectDir: '',
        jsonlFile: '',
        isExternal: true,
        providerId: 'codex',
      });
      store.set(1, agent);
      const messages: Record<string, unknown>[] = [];
      store.on('broadcast', (m) => messages.push(m));
      store.setWorkingDirectory(agent, 'C:/Projects/site');
      expect(messages.at(-1)).toMatchObject({ type: 'agentArea', area: 'Studio' });
      store.setWorkingDirectory(agent, 'C:/Projects/app');
      expect(messages.at(-1)).toMatchObject({ type: 'agentArea', area: 'Programs' });
      expect(JSON.stringify([...store.officeAreaMessages(), ...messages])).not.toContain(
        'C:/Projects',
      );
      fs.writeFileSync(file, JSON.stringify({ ...config, restArea: 'missing' }));
      expect(() => loadOfficeAreas(file)).toThrow();
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...config,
          areas: [{ name: 'Lounge', rectangles: [{ col: -1, row: 0, width: 0, height: 1 }] }],
        }),
      );
      expect(() => loadOfficeAreas(file)).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
