import { useEffect, useRef, useState } from "react";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import type { LocalUser } from "../lib/identity";
import { presenceServerUrl } from "../lib/room";

export interface ProjectPeer {
  clientId: number;
  name: string;
  color: string;
  activeFilePath: string | null;
}

const MESSAGE_AWARENESS = 1;
const REMOTE_ORIGIN = "remote";

/**
 * Project-wide "who's here", independent of which file each person has
 * open — deliberately a separate connection from the per-file collaboration
 * room in LatexEditor.tsx (see backend/src/presenceServer.ts for why: it's
 * a bare awareness channel, no document content, so it doesn't fit the
 * y-websocket/y-monaco machinery built for actual document sync).
 *
 * Only editors get this (it rides the same edit-token-gated WebSocket as
 * live collaboration) — read-only viewers see a static, non-live project.
 */
export function useProjectPresence(
  projectId: string | null,
  editToken: string | null,
  localUser: LocalUser,
  activeFilePath: string | null
): ProjectPeer[] {
  const [peers, setPeers] = useState<ProjectPeer[]>([]);
  const awarenessRef = useRef<awarenessProtocol.Awareness | null>(null);

  useEffect(() => {
    if (!projectId || !editToken) {
      setPeers([]);
      return;
    }

    const anchor = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(anchor);
    awarenessRef.current = awareness;
    awareness.setLocalStateField("user", localUser);

    const ws = new WebSocket(presenceServerUrl(projectId, editToken));
    ws.binaryType = "arraybuffer";

    function sendUpdate(changedClients: number[]) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients));
      ws.send(encoding.toUint8Array(encoder));
    }

    function reportPeers() {
      const states = awareness.getStates();
      const list: ProjectPeer[] = [];
      states.forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const user = (state as { user?: { name: string; color: string } }).user;
        const activeFile = (state as { activeFilePath?: string | null }).activeFilePath ?? null;
        if (user) list.push({ clientId, name: user.name, color: user.color, activeFilePath: activeFile });
      });
      setPeers(list);
    }

    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      reportPeers();
      if (origin !== REMOTE_ORIGIN) sendUpdate(added.concat(updated, removed));
    });

    ws.addEventListener("open", () => sendUpdate([awareness.clientID]));
    ws.addEventListener("message", (ev) => {
      const decoder = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      if (decoding.readVarUint(decoder) !== MESSAGE_AWARENESS) return;
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), REMOTE_ORIGIN);
    });

    return () => {
      awarenessRef.current = null;
      awareness.setLocalState(null);
      ws.close();
    };
  }, [projectId, editToken, localUser]);

  useEffect(() => {
    awarenessRef.current?.setLocalStateField("activeFilePath", activeFilePath);
  }, [activeFilePath]);

  return peers;
}
