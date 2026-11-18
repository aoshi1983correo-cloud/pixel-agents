export const AGY_POLL_MS = 500;
export const AGY_DISCOVERY_MS = 3_000;
export const AGY_IDLE_MS = 300_000;
export const AGY_READ_BYTES = 256 * 1024;
export const AGY_MAX_LINE_CHARS = 2 * 1024 * 1024;
export const AGY_READING_TOOLS = new Set([
  'read_file',
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
  'view_code_item',
  'search_web',
]);
