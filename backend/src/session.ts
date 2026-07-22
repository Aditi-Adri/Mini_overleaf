import path from "node:path";
import { config } from "./config.js";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

/**
 * Resolves a session's workspace directory, guaranteeing the result stays
 * inside workspacesRoot even if something upstream lets a malformed id through.
 */
export function workspaceDirFor(sessionId: string): string {
  const dir = path.resolve(config.workspacesRoot, sessionId);
  const root = path.resolve(config.workspacesRoot);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error("Resolved workspace path escapes workspaces root");
  }
  return dir;
}
