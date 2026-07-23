// Empty string keeps requests relative (/api/...), which works both with the
// Vite dev server proxy and with the Docker/nginx setup. Override via
// VITE_API_BASE_URL for other deployments.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export interface Project {
  id: string;
  name: string;
  mainFileId: string | null;
  createdAt: string;
}

export interface ProjectFile {
  id: string;
  projectId: string;
  path: string;
  kind: "text" | "binary";
  contentType: string | null;
  sizeBytes: number;
  updatedAt: string;
}

export interface ProjectWithFiles {
  project: Project;
  files: ProjectFile[];
}

export interface CompileErrorEntry {
  file: string | null;
  line: number | null;
  message: string;
}

async function extractError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // response wasn't JSON — fall through to the generic message
  }
  return `Request failed (HTTP ${response.status}).`;
}

async function extractCompileError(response: Response): Promise<{ error: string; errors: CompileErrorEntry[] }> {
  try {
    const body = (await response.json()) as { error?: string; errors?: CompileErrorEntry[] };
    if (body?.error) return { error: body.error, errors: body.errors ?? [] };
  } catch {
    // response wasn't JSON — fall through to the generic message
  }
  return { error: `Request failed (HTTP ${response.status}).`, errors: [] };
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(await extractError(response));
  return response.json() as Promise<T>;
}

/** Only mutating endpoints need this — the project id alone grants read access, editToken grants write. */
function editHeaders(editToken: string): HeadersInit {
  return { "X-Edit-Token": editToken };
}

export function createProject(name?: string): Promise<ProjectWithFiles & { editToken: string }> {
  return apiJson("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
}

/** Creates a brand new project from a .zip's contents — a separate project, never merged into whatever's currently open. */
export async function uploadZipProject(file: File, name?: string): Promise<ProjectWithFiles & { editToken: string; skipped: string[] }> {
  const form = new FormData();
  form.append("file", file);
  if (name) form.append("name", name);
  const response = await fetch(`${API_BASE}/api/projects/upload-zip`, { method: "POST", body: form });
  if (!response.ok) throw new Error(await extractError(response));
  return response.json();
}

export async function getProject(projectId: string): Promise<ProjectWithFiles | null> {
  const response = await fetch(`${API_BASE}/api/projects/${projectId}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await extractError(response));
  return response.json() as Promise<ProjectWithFiles>;
}

export function setMainFile(projectId: string, fileId: string, editToken: string): Promise<{ project: Project }> {
  return apiJson<{ project: Project }>(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: editHeaders(editToken),
    body: JSON.stringify({ mainFileId: fileId }),
  });
}

export function createTextFile(
  projectId: string,
  path: string,
  editToken: string,
  content = ""
): Promise<{ file: ProjectFile; files: ProjectFile[] }> {
  return apiJson(`/api/projects/${projectId}/files`, {
    method: "POST",
    headers: editHeaders(editToken),
    body: JSON.stringify({ path, content }),
  });
}

export async function uploadFile(
  projectId: string,
  path: string,
  file: File,
  editToken: string
): Promise<{ file: ProjectFile; files: ProjectFile[] }> {
  const form = new FormData();
  form.append("path", path);
  form.append("file", file);
  const response = await fetch(`${API_BASE}/api/projects/${projectId}/files/upload`, {
    method: "POST",
    headers: editHeaders(editToken),
    body: form,
  });
  if (!response.ok) throw new Error(await extractError(response));
  return response.json();
}

export function renameFile(
  projectId: string,
  fileId: string,
  newPath: string,
  editToken: string
): Promise<{ file: ProjectFile; files: ProjectFile[] }> {
  return apiJson(`/api/projects/${projectId}/files/${fileId}`, {
    method: "PATCH",
    headers: editHeaders(editToken),
    body: JSON.stringify({ path: newPath }),
  });
}

export function deleteFile(projectId: string, fileId: string, editToken: string): Promise<{ files: ProjectFile[] }> {
  return apiJson(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE", headers: editHeaders(editToken) });
}

export function rawFileUrl(projectId: string, fileId: string): string {
  return `${API_BASE}/api/projects/${projectId}/files/${fileId}/raw`;
}

export type CompileResult =
  | { ok: true; pdfBytes: Uint8Array; cache: "HIT" | "MISS"; durationMs: number }
  | { ok: false; error: string; errors: CompileErrorEntry[] };

export async function compileProject(projectId: string, signal: AbortSignal): Promise<CompileResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/projects/${projectId}/compile`, { method: "POST", signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: `Could not reach the compile server: ${String(err)}`, errors: [] };
  }

  const cache = response.headers.get("X-Cache") === "HIT" ? "HIT" : "MISS";
  const durationMs = Number(response.headers.get("X-Compile-Ms") ?? 0);

  if (response.ok) {
    const pdfBytes = new Uint8Array(await response.arrayBuffer());
    return { ok: true, pdfBytes, cache, durationMs };
  }

  const { error, errors } = await extractCompileError(response);
  return { ok: false, error, errors };
}

export interface VersionEntry {
  hash: string;
  createdAt: string;
  message: string;
  trigger: "compile" | "manual";
}

export interface VersionDiffFile {
  path: string;
  status: "added" | "removed" | "modified" | "binary";
  diffText: string;
}

export async function listVersions(projectId: string): Promise<VersionEntry[]> {
  const { versions } = await apiJson<{ versions: VersionEntry[] }>(`/api/projects/${projectId}/versions`);
  return versions;
}

export async function getVersionDiff(projectId: string, from: string, to: string): Promise<VersionDiffFile[]> {
  const params = new URLSearchParams({ from, to });
  const { files } = await apiJson<{ files: VersionDiffFile[] }>(`/api/projects/${projectId}/versions/diff?${params}`);
  return files;
}

export function saveVersion(
  projectId: string,
  editToken: string,
  label?: string
): Promise<{ committed: boolean; hash: string | null }> {
  return apiJson(`/api/projects/${projectId}/versions`, {
    method: "POST",
    headers: editHeaders(editToken),
    body: JSON.stringify({ label }),
  });
}
