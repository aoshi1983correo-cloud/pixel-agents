import { describe, expect, it } from 'vitest';

import { activityInput, privateActivity } from '../src/privateActivity.js';
import { parseRecord as agy } from '../src/providers/hook/antigravity/antigravity.js';
import { parseRecord as codex } from '../src/providers/hook/codex/codex.js';

describe('private activity metadata', () => {
  it.each([
    ['read_file', { file_path: 'C:\\invented\\secret\\demo.ts' }, 'Leyendo demo.ts'],
    [
      'write_file',
      { TargetFile: '/invented/private/demo.ts', content: 'SECRET' },
      'Editando demo.ts',
    ],
    ['run_command', { CommandLine: 'npm run secret --token=SECRET' }, 'Ejecutando npm'],
    ['exec_command', { cmd: '"C:\\tools\\git.exe" diff SECRET' }, 'Ejecutando git.exe'],
    ['grep_search', { query: 'SECRET', path: '/private' }, 'Buscando'],
    ['unknown_SECRET', { content: 'SECRET' }, 'Trabajando'],
    [
      'apply_patch',
      '*** Begin Patch\n*** Update File: /invented/secret/demo.ts\n@@\n-SECRET',
      'Editando demo.ts',
    ],
  ])('formats %s with only a basename or program', (tool, input, expected) => {
    expect(privateActivity(tool, input)).toBe(expected);
    expect(JSON.stringify(activityInput(input))).not.toContain('SECRET');
  });
  it('strips arguments before normalized events escape the providers', () => {
    const event = codex({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'npm run SECRET' }),
      },
    });
    expect(event).toMatchObject({ input: { program: 'npm' } });
    const other = agy({
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        { name: 'view_file', args: { AbsolutePath: '/private/demo.ts', content: 'SECRET' } },
      ],
    });
    expect(other).toMatchObject({ input: { file: 'demo.ts' } });
    expect(JSON.stringify([event, other])).not.toContain('SECRET');
  });
  it('does not expose shell substitutions, multiline names or malformed JSON', () => {
    expect(activityInput({ cmd: '$(SECRET)' })).toEqual({});
    expect(activityInput({ file_path: '/private/a\nSECRET' })).toEqual({});
    expect(activityInput('{broken SECRET')).toEqual({});
  });
});
