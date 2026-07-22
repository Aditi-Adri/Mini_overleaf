export interface CompileErrorEntry {
  /** Project-relative file path as Tectonic reported it, or null for engine-level errors with no clear file/line (e.g. unexpected EOF). */
  file: string | null;
  line: number | null;
  message: string;
}

// Tectonic's "-X compile" (v2 CLI) prints diagnostics as one-liners:
//   error: main.tex:12: Undefined control sequence
//   error: !File ended while scanning use of \textbf
// The trailing "halted on potentially-recoverable error..." line is always
// emitted alongside a real error above it and adds no information, so it's
// filtered out. The file-path group intentionally excludes only `:` (not
// whitespace) — uploaded/renamed files may legitimately contain spaces,
// and `:` is already rejected by isValidRelativePath, so it's an
// unambiguous delimiter here.
const ERROR_LINE_RE = /^error:\s+(?:([^:]+):(\d+):\s+)?(.+?)\s*$/gm;
const BOILERPLATE_RE = /^halted on potentially-recoverable error/i;

export function parseCompileErrors(log: string): CompileErrorEntry[] {
  const entries: CompileErrorEntry[] = [];
  for (const match of log.matchAll(ERROR_LINE_RE)) {
    const [, file, lineStr, rawMessage] = match;
    const message = rawMessage.trim();
    if (!message || BOILERPLATE_RE.test(message)) continue;
    entries.push({ file: file ?? null, line: lineStr ? Number(lineStr) : null, message });
  }
  return entries;
}
