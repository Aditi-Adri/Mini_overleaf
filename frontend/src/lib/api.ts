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

async function extractError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // response wasn't JSON — fall through to the generic message
  }
  return `Request failed (HTTP ${response.status}).`;
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
  | { ok: false; error: string };

export async function compileProject(projectId: string, signal: AbortSignal): Promise<CompileResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/projects/${projectId}/compile`, { method: "POST", signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: `Could not reach the compile server: ${String(err)}` };
  }

  const cache = response.headers.get("X-Cache") === "HIT" ? "HIT" : "MISS";
  const durationMs = Number(response.headers.get("X-Compile-Ms") ?? 0);

  if (response.ok) {
    const pdfBytes = new Uint8Array(await response.arrayBuffer());
    return { ok: true, pdfBytes, cache, durationMs };
  }

  return { ok: false, error: await extractError(response) };
}
