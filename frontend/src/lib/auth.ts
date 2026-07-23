const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const SESSION_TOKEN_KEY = "mini-overleaf:session-token";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  pictureUrl: string | null;
}

export interface SavedProject {
  id: string;
  name: string;
  createdAt: string;
  savedAt: string;
  canEdit: boolean;
  editToken: string | null;
}

export function getStoredSessionToken(): string | null {
  return localStorage.getItem(SESSION_TOKEN_KEY);
}

function storeSessionToken(token: string): void {
  localStorage.setItem(SESSION_TOKEN_KEY, token);
}

function clearStoredSessionToken(): void {
  localStorage.removeItem(SESSION_TOKEN_KEY);
}

async function extractError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // not JSON — fall through
  }
  return `Request failed (HTTP ${response.status}).`;
}

function authHeaders(token: string): HeadersInit {
  return { "X-Session-Token": token };
}

/** Exchanges a Google ID token (from the Sign in with Google button) for our own session token, storing it. */
export async function signInWithGoogle(idToken: string): Promise<AuthUser> {
  const response = await fetch(`${API_BASE}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) throw new Error(await extractError(response));
  const { token, user } = (await response.json()) as { token: string; user: AuthUser };
  storeSessionToken(token);
  return user;
}

export async function signOut(): Promise<void> {
  const token = getStoredSessionToken();
  clearStoredSessionToken();
  if (!token) return;
  await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", headers: authHeaders(token) }).catch(() => {
    // best-effort — the local token is already cleared either way
  });
}

/** Returns null (not an error) when there's no session or it's expired/invalid — that's just "signed out". */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = getStoredSessionToken();
  if (!token) return null;
  const response = await fetch(`${API_BASE}/api/me`, { headers: authHeaders(token) });
  if (response.status === 401) {
    clearStoredSessionToken();
    return null;
  }
  if (!response.ok) throw new Error(await extractError(response));
  const { user } = (await response.json()) as { user: AuthUser };
  return user;
}

export async function listSavedProjects(): Promise<SavedProject[]> {
  const token = getStoredSessionToken();
  if (!token) return [];
  const response = await fetch(`${API_BASE}/api/me/projects`, { headers: authHeaders(token) });
  if (!response.ok) throw new Error(await extractError(response));
  const { projects } = (await response.json()) as { projects: SavedProject[] };
  return projects;
}

export async function saveCurrentProject(projectId: string, editToken: string | null): Promise<{ canEdit: boolean }> {
  const token = getStoredSessionToken();
  if (!token) throw new Error("Sign in first to save a project.");
  const response = await fetch(`${API_BASE}/api/projects/${projectId}/save`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ editToken }),
  });
  if (!response.ok) throw new Error(await extractError(response));
  return response.json();
}

export async function unsaveProject(projectId: string): Promise<void> {
  const token = getStoredSessionToken();
  if (!token) return;
  const response = await fetch(`${API_BASE}/api/projects/${projectId}/save`, { method: "DELETE", headers: authHeaders(token) });
  if (!response.ok) throw new Error(await extractError(response));
}

export async function isCurrentProjectSaved(projectId: string): Promise<boolean> {
  const token = getStoredSessionToken();
  if (!token) return false;
  const response = await fetch(`${API_BASE}/api/projects/${projectId}/saved`, { headers: authHeaders(token) });
  if (!response.ok) return false;
  const { saved } = (await response.json()) as { saved: boolean };
  return saved;
}
