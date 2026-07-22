import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { deleteObject, getObject, putObject, storageKeyFor } from "./storage.js";

export interface Project {
  id: string;
  name: string;
  mainFileId: string | null;
  createdAt: string;
}

export interface FileMeta {
  id: string;
  projectId: string;
  path: string;
  kind: "text" | "binary";
  contentType: string | null;
  sizeBytes: number;
  updatedAt: string;
}

export interface FileWithContent extends FileMeta {
  content: string | null;
  storageKey: string | null;
}

const MAX_PATH_LENGTH = 200;
// Control chars, backslash, and the characters NTFS/Windows reject outright.
// Everything else (spaces, parentheses, commas, accented/unicode letters) is
// allowed so real-world filenames like "Screenshot 2026-07-22 (1).png" work.
const UNSAFE_CHARS_RE = /[\x00-\x1f\\<>:"|?*]/;
const RESERVED_WINDOWS_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.[^.]*)?$/i;

/**
 * Guards against path traversal, absolute paths, and filesystem-unsafe
 * names, since `path` doubles as a real filesystem path during compile.
 * Segments may never start with `.` — besides blocking `.`/`..` traversal,
 * this keeps user files from ever colliding with internal dotfiles like
 * `.project.sha256` / `.binaries.json` (see compileService.ts).
 */
export function isValidRelativePath(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_PATH_LENGTH) return false;
  if (UNSAFE_CHARS_RE.test(candidate)) return false;
  return candidate.split("/").every((segment) => {
    if (segment === "" || segment.startsWith(".")) return false;
    if (segment !== segment.trim() || segment.endsWith(".")) return false;
    return !RESERVED_WINDOWS_NAME_RE.test(segment);
  });
}

function rowToProject(row: { id: string; name: string; main_file_id: string | null; created_at: Date }): Project {
  return { id: row.id, name: row.name, mainFileId: row.main_file_id, createdAt: row.created_at.toISOString() };
}

function rowToFileMeta(row: {
  id: string;
  project_id: string;
  path: string;
  kind: "text" | "binary";
  content_type: string | null;
  size_bytes: number;
  updated_at: Date;
}): FileMeta {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    kind: row.kind,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    updatedAt: row.updated_at.toISOString(),
  };
}

const DEMO_FILES: Array<{ path: string; content: string }> = [
  {
    path: "main.tex",
    content: String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage[hidelinks]{hyperref}
\usepackage{cite}

\title{Project Report}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle

\input{sections/introduction}

\bibliographystyle{plain}
\bibliography{references}

\end{document}
`,
  },
  {
    path: "sections/introduction.tex",
    content: String.raw`\section{Introduction}

This project spans multiple files: this section lives on its own and is
pulled into \texttt{main.tex} with \verb|\input|, and the citation below
comes from \texttt{references.bib}~\cite{knuth1984texbook}.

Use the file tree on the left to add sections, upload images, or edit the
bibliography --- every file syncs and compiles together.
`,
  },
  {
    path: "references.bib",
    content: String.raw`@book{knuth1984texbook,
  author    = {Donald E. Knuth},
  title     = {The {TeXbook}},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`,
  },
];

/**
 * Creates a project pre-populated with a small multi-file demo (main.tex +
 * a section + a .bib), so a new project immediately shows off \input and
 * bibliography support rather than opening on a blank file.
 *
 * Returns `editToken` alongside the (public-safe) Project — this is the
 * *only* place that token is ever handed out in plaintext. The caller is
 * responsible for giving it to the creator and never re-exposing it
 * through a general-purpose read endpoint (see server.ts).
 */
export async function createProject(name = "Untitled project"): Promise<{ project: Project; editToken: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const projectId = randomUUID();
    const projectRow = await client.query(
      "INSERT INTO projects (id, name) VALUES ($1, $2) RETURNING id, name, main_file_id, edit_token, created_at",
      [projectId, name]
    );

    let mainFileId: string | null = null;
    for (const file of DEMO_FILES) {
      const fileId = randomUUID();
      await client.query(
        `INSERT INTO files (id, project_id, path, kind, content, size_bytes)
         VALUES ($1, $2, $3, 'text', $4, $5)`,
        [fileId, projectId, file.path, file.content, Buffer.byteLength(file.content, "utf8")]
      );
      if (file.path === "main.tex") mainFileId = fileId;
    }
    await client.query("UPDATE projects SET main_file_id = $1 WHERE id = $2", [mainFileId, projectId]);
    await client.query("COMMIT");

    const row = projectRow.rows[0];
    return { project: rowToProject({ ...row, main_file_id: mainFileId }), editToken: row.edit_token as string };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getProject(projectId: string): Promise<Project | null> {
  const result = await pool.query("SELECT id, name, main_file_id, created_at FROM projects WHERE id = $1", [projectId]);
  return result.rows[0] ? rowToProject(result.rows[0]) : null;
}

/** Constant-time-ish check isn't critical here (tokens are 122-bit random, not low-entropy passwords) — a plain equality check against a per-request DB lookup is the right cost/complexity tradeoff. */
export async function verifyEditToken(projectId: string, token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const result = await pool.query("SELECT 1 FROM projects WHERE id = $1 AND edit_token = $2", [projectId, token]);
  return (result.rowCount ?? 0) > 0;
}

export async function listFiles(projectId: string): Promise<FileMeta[]> {
  const result = await pool.query(
    "SELECT id, project_id, path, kind, content_type, size_bytes, updated_at FROM files WHERE project_id = $1 ORDER BY path",
    [projectId]
  );
  return result.rows.map(rowToFileMeta);
}

export async function getFile(fileId: string): Promise<FileWithContent | null> {
  const result = await pool.query(
    "SELECT id, project_id, path, kind, content, storage_key, content_type, size_bytes, updated_at FROM files WHERE id = $1",
    [fileId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...rowToFileMeta(row), content: row.content, storageKey: row.storage_key };
}

export async function createTextFile(projectId: string, path: string, content = ""): Promise<FileMeta> {
  const fileId = randomUUID();
  const result = await pool.query(
    `INSERT INTO files (id, project_id, path, kind, content, size_bytes)
     VALUES ($1, $2, $3, 'text', $4, $5)
     RETURNING id, project_id, path, kind, content_type, size_bytes, updated_at`,
    [fileId, projectId, path, content, Buffer.byteLength(content, "utf8")]
  );
  return rowToFileMeta(result.rows[0]);
}

export async function createBinaryFile(
  projectId: string,
  path: string,
  data: Buffer,
  contentType: string
): Promise<FileMeta> {
  const fileId = randomUUID();
  const key = storageKeyFor(projectId, fileId);
  await putObject(key, data, contentType);
  const result = await pool.query(
    `INSERT INTO files (id, project_id, path, kind, storage_key, content_type, size_bytes)
     VALUES ($1, $2, $3, 'binary', $4, $5, $6)
     RETURNING id, project_id, path, kind, content_type, size_bytes, updated_at`,
    [fileId, projectId, path, key, contentType, data.byteLength]
  );
  return rowToFileMeta(result.rows[0]);
}

export async function getBinaryContent(storageKey: string): Promise<Buffer> {
  return getObject(storageKey);
}

/** Persists a text file's current content — used both by the "save" path and the collab server's debounced writes. */
export async function updateFileContent(fileId: string, content: string): Promise<void> {
  await pool.query("UPDATE files SET content = $1, size_bytes = $2, updated_at = now() WHERE id = $3 AND kind = 'text'", [
    content,
    Buffer.byteLength(content, "utf8"),
    fileId,
  ]);
}

export async function renameFile(fileId: string, newPath: string): Promise<FileMeta> {
  const result = await pool.query(
    `UPDATE files SET path = $1, updated_at = now() WHERE id = $2
     RETURNING id, project_id, path, kind, content_type, size_bytes, updated_at`,
    [newPath, fileId]
  );
  if (!result.rows[0]) throw new Error("File not found");
  return rowToFileMeta(result.rows[0]);
}

export async function setMainFile(projectId: string, fileId: string): Promise<void> {
  await pool.query("UPDATE projects SET main_file_id = $1 WHERE id = $2", [fileId, projectId]);
}

export async function deleteFile(projectId: string, fileId: string): Promise<void> {
  const file = await getFile(fileId);
  if (!file || file.projectId !== projectId) return;

  await pool.query("DELETE FROM files WHERE id = $1", [fileId]);
  await pool.query("UPDATE projects SET main_file_id = NULL WHERE id = $1 AND main_file_id = $2", [projectId, fileId]);

  if (file.kind === "binary" && file.storageKey) {
    await deleteObject(file.storageKey);
  }
}
