const PROJECT_PARAM = "project";
const TOKEN_PARAM = "token";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The project id lives in the URL, not localStorage — that's what makes a
 * project shareable: send someone the link, they land in the same project.
 * Unlike a single Phase 2 document, a project can't just be minted locally
 * as a random id — it has to actually exist (with seeded files) in
 * Postgres, so resolving one is a server round trip. See App.tsx: it reads
 * this, tries to fetch that project, and falls back to creating a new one
 * (via setProjectIdInUrl) if the id is missing or no longer exists.
 */
export function getProjectIdFromUrl(): string | null {
  const existing = new URL(window.location.href).searchParams.get(PROJECT_PARAM);
  return existing && UUID_RE.test(existing) ? existing : null;
}

export function setProjectIdInUrl(projectId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(PROJECT_PARAM, projectId);
  window.history.replaceState(null, "", url.toString());
}

/**
 * Edit access is a capability secret (see backend/src/projects.ts), not
 * something the plain project id grants. It arrives one of two ways:
 *  - freshly minted, in the response to creating a project, or
 *  - via a `?token=...` edit link someone shared with you.
 * Either way it's immediately moved into localStorage (scoped per project)
 * and stripped out of the visible URL, so it doesn't linger in browser
 * history, autocomplete, or a screenshot of the address bar.
 */
function tokenStorageKey(projectId: string): string {
  return `mini-overleaf:edit-token:${projectId}`;
}

export function getStoredEditToken(projectId: string): string | null {
  return localStorage.getItem(tokenStorageKey(projectId));
}

export function storeEditToken(projectId: string, token: string): void {
  localStorage.setItem(tokenStorageKey(projectId), token);
}

export function consumeTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get(TOKEN_PARAM);
  if (token) {
    url.searchParams.delete(TOKEN_PARAM);
    window.history.replaceState(null, "", url.toString());
  }
  return token;
}

export function editLinkFor(projectId: string, editToken: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set(PROJECT_PARAM, projectId);
  url.searchParams.set(TOKEN_PARAM, editToken);
  return url.toString();
}

export function viewLinkFor(projectId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set(PROJECT_PARAM, projectId);
  url.searchParams.delete(TOKEN_PARAM);
  return url.toString();
}

/** ws(s)://<same-origin>/yjs — the room name (a file id) is appended by WebsocketProvider itself. */
export function collabServerUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/yjs`;
}

/** ws(s)://<same-origin>/presence/<projectId>?token=... — project-wide presence, separate from the per-file rooms above. */
export function presenceServerUrl(projectId: string, editToken: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/presence/${projectId}?token=${encodeURIComponent(editToken)}`;
}

/** Must match CONTENT_KEY in backend/src/collabServer.ts — both sides read/write the same shared Y.Text by name. */
export const CONTENT_KEY = "content";
