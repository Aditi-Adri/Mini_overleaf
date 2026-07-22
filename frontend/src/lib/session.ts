const STORAGE_KEY = "mini-overleaf:session-id";

/**
 * Each browser gets its own persistent workspace on the backend, identified
 * by a UUID kept in localStorage. There's no login in phase 1, but this
 * keeps concurrent users (or tabs) from ever colliding on the same compile
 * workspace, and gives every visitor working aux/cache files across reloads.
 */
export function getSessionId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
