import { getFile, verifyEditToken } from "./projects.js";
import { isValidSessionId } from "./session.js";

export type UpgradeTarget = { kind: "yjs"; fileId: string } | { kind: "presence"; projectId: string };

/**
 * Resolves an incoming WebSocket upgrade request to whichever room it's
 * asking for, or null if the path doesn't match a known room type, the id
 * in it is malformed, or the token doesn't grant edit access to the
 * relevant project. Pulled out of server.ts's upgrade handler so the
 * authorization logic itself — the part actually worth testing — can be
 * exercised directly against real Postgres without spinning up the whole
 * HTTP/WebSocket server.
 */
export async function resolveUpgradeTarget(pathname: string, token: string | null): Promise<UpgradeTarget | null> {
  const yjsMatch = /^\/yjs\/([^/]+)$/.exec(pathname);
  if (yjsMatch) {
    const fileId = yjsMatch[1];
    if (!isValidSessionId(fileId)) return null;
    const file = await getFile(fileId);
    if (!file || !(await verifyEditToken(file.projectId, token))) return null;
    return { kind: "yjs", fileId };
  }

  const presenceMatch = /^\/presence\/([^/]+)$/.exec(pathname);
  if (presenceMatch) {
    const projectId = presenceMatch[1];
    if (!isValidSessionId(projectId) || !(await verifyEditToken(projectId, token))) return null;
    return { kind: "presence", projectId };
  }

  return null;
}
