import { isRecord } from '../../core/src/isRecord.js';

const READING = /^(Read|read_file|view_file|view_image|view_code_item)$/;
const SEARCH = /search|grep|glob|WebFetch|find_by_name|list_dir|list_mcp/i;
const EDITING =
  /^(Edit|Write|MultiEdit|apply_patch|write_file|replace_file_content|multi_replace_file_content)$/;
const EXECUTING = /^(Bash|exec_command|shell|shell_command|run_command|command_status)$/;
const SAFE_NAME = /^[\p{L}\p{N}_. ()@+-]{1,100}$/u;
const PROGRAM = /^[a-zA-Z][a-zA-Z0-9_.+-]{0,39}$/;

/** Whitelist output metadata at the provider boundary; never retain raw arguments. */
export function activityInput(raw: unknown): { file?: string; program?: string } {
  let input = raw;
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw);
    } catch {
      const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(raw);
      input = header ? { file_path: header[1] } : {};
    }
  }
  if (!isRecord(input)) return {};
  const result: { file?: string; program?: string } = {};
  const file =
    input.file ??
    input.file_path ??
    input.path ??
    input.AbsolutePath ??
    input.TargetFile ??
    input.File;
  if (typeof file === 'string') {
    const base = file.split(/[\\/]/).pop() ?? '';
    if (SAFE_NAME.test(base) && base !== '.' && base !== '..') result.file = base;
  }
  const cmd = input.program ?? input.cmd ?? input.command ?? input.CommandLine;
  const first = Array.isArray(cmd)
    ? cmd[0]
    : typeof cmd === 'string'
      ? /^(?:"([^"]+)"|'([^']+)'|([^\s;&|<>`$]+))/.exec(cmd.trim())?.slice(1).find(Boolean)
      : undefined;
  if (typeof first === 'string') {
    const base = first.split(/[\\/]/).pop() ?? '';
    if (PROGRAM.test(base)) result.program = base;
  }
  return result;
}
export function privateActivity(name: string, raw?: unknown): string {
  const input = activityInput(raw);
  if (SEARCH.test(name)) return 'Buscando';
  if (READING.test(name)) return input.file ? `Leyendo ${input.file}` : 'Leyendo';
  if (EDITING.test(name)) return input.file ? `Editando ${input.file}` : 'Editando archivos';
  if (EXECUTING.test(name))
    return input.program ? `Ejecutando ${input.program}` : 'Ejecutando programa';
  if (name === 'request_user_input') return 'Esperando respuesta';
  return 'Trabajando';
}
