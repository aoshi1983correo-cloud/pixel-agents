export const CODEX_POLL_MS = 500;
export const CODEX_DISCOVERY_MS = 3_000;
export const CODEX_IDLE_MS = 300_000;
export const CODEX_READ_BYTES = 256 * 1024;
export const CODEX_MAX_LINE_CHARS = 2 * 1024 * 1024;
export const CODEX_READING_TOOLS = new Set([
  'read_file',
  'list_dir',
  'grep',
  'file_search',
  'view_image',
  'read_thread_terminal',
  'list_mcp_resources',
  'list_mcp_resource_templates',
]);
