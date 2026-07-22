const DOC_PARAM = "doc";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The document/room id now lives in the URL, not localStorage — that's what
 * makes a document shareable: send someone the link, they land in the same
 * room. A missing or malformed id mints a fresh one and rewrites the URL
 * (without a navigation), so reloading keeps you in the same room and the
 * address bar is immediately copy-pasteable.
 */
export function getOrCreateDocId(): string {
  const url = new URL(window.location.href);
  const existing = url.searchParams.get(DOC_PARAM);
  if (existing && UUID_RE.test(existing)) return existing;

  const id = crypto.randomUUID();
  url.searchParams.set(DOC_PARAM, id);
  window.history.replaceState(null, "", url.toString());
  return id;
}

/** ws(s)://<same-origin>/yjs — the room name is appended by WebsocketProvider itself. */
export function collabServerUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/yjs`;
}

/** Must match CONTENT_KEY in backend/src/collabServer.ts — both sides read/write the same shared Y.Text by name. */
export const CONTENT_KEY = "content";
