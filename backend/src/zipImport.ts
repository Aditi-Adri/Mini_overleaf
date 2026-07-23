import AdmZip from "adm-zip";
import { config } from "./config.js";
import { isValidRelativePath } from "./projects.js";

export interface ExtractedFile {
  path: string;
  kind: "text" | "binary";
  content: Buffer;
  contentType: string;
}

export interface ZipExtractionResult {
  files: ExtractedFile[];
  /** Entry names rejected for unsafe/invalid paths (traversal, reserved names, etc.) — extraction still succeeds around them. */
  skipped: string[];
}

const TEXT_EXTENSIONS = new Set([".tex", ".bib", ".sty", ".cls", ".bst", ".bbx", ".cbx", ".txt", ".md", ".cfg"]);

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".eps": "application/postscript",
  ".svg": "image/svg+xml",
  ".tex": "text/x-tex",
  ".bib": "text/x-bibtex",
};

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}

function guessContentType(filePath: string): string {
  return CONTENT_TYPES[extensionOf(filePath)] ?? "application/octet-stream";
}

function isTextPath(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(filePath));
}

/** Zip entry names always use forward slashes per spec, but normalize defensively and drop any leading "./" or "/". */
function normalizeEntryPath(rawName: string): string {
  return rawName.replace(/\\/g, "/").replace(/^\.?\/+/, "");
}

/**
 * If every entry shares one common top-level folder — the usual
 * "MyProject/main.tex, MyProject/images/x.png" shape a zip export produces —
 * strip that wrapper so files land at sensible project-relative paths
 * instead of one level too deep.
 */
function stripCommonPrefix(paths: string[]): string[] {
  if (paths.length === 0) return paths;
  const firstSlash = paths[0].indexOf("/");
  if (firstSlash === -1) return paths;
  const prefix = paths[0].slice(0, firstSlash + 1);
  const allShare = paths.every((p) => p.startsWith(prefix));
  return allShare ? paths.map((p) => p.slice(prefix.length)) : paths;
}

/**
 * Extracts a project archive into validated {path, kind, content} entries.
 * Uncompressed size is checked from zip metadata (header.size) *before* any
 * entry is actually decompressed via getData(), so a zip lying about being
 * small can't force decompression of an oversized payload first.
 */
export function extractZip(buffer: Buffer): ZipExtractionResult {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(`Not a valid zip file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length === 0) throw new Error("The zip file is empty.");
  if (entries.length > config.maxZipEntryCount) {
    throw new Error(`The zip contains too many files (${entries.length}, max ${config.maxZipEntryCount}).`);
  }

  const totalUncompressed = entries.reduce((sum, e) => sum + e.header.size, 0);
  if (totalUncompressed > config.maxZipUncompressedBytes) {
    throw new Error(`The zip's uncompressed contents are too large (max ${config.maxZipUncompressedBytes} bytes).`);
  }

  // Validity is checked on the raw (pre-strip) path *first*, and only the
  // entries that pass feed into the common-prefix computation — otherwise a
  // single rejected entry (traversal, unsafe chars) at the top level would
  // silently defeat wrapper-folder stripping for every legitimate file
  // alongside it.
  const skipped: string[] = [];
  const valid: Array<{ entry: (typeof entries)[number]; path: string }> = [];
  entries.forEach((entry) => {
    const rawPath = normalizeEntryPath(entry.entryName);
    if (rawPath && isValidRelativePath(rawPath)) {
      valid.push({ entry, path: rawPath });
    } else {
      skipped.push(entry.entryName);
    }
  });

  const strippedPaths = stripCommonPrefix(valid.map((v) => v.path));
  const files: ExtractedFile[] = valid.map(({ entry }, i) => {
    const filePath = strippedPaths[i];
    return {
      path: filePath,
      kind: isTextPath(filePath) ? "text" : "binary",
      content: entry.getData(),
      contentType: guessContentType(filePath),
    };
  });

  if (files.length === 0) throw new Error("No valid project files were found in the zip.");

  return { files, skipped };
}

/** Prefers a root-level main.tex, then any root-level .tex, then the alphabetically-first .tex anywhere. */
export function pickMainFile(files: ExtractedFile[]): string | null {
  const texFiles = files.filter((f) => f.path.toLowerCase().endsWith(".tex"));
  const namedMain = texFiles.find((f) => f.path.toLowerCase() === "main.tex");
  if (namedMain) return namedMain.path;
  const rootTex = texFiles.find((f) => !f.path.includes("/"));
  if (rootTex) return rootTex.path;
  if (texFiles.length === 0) return null;
  return [...texFiles].sort((a, b) => a.path.localeCompare(b.path))[0].path;
}
