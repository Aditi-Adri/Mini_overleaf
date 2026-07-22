import type { IncomingMessage } from "node:http";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as mapUtil from "lib0/map";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import type { WebSocket } from "ws";

/**
 * Project-wide presence: who's currently in this project and, via their
 * awareness state, which file they're looking at. Deliberately separate
 * from collabServer.ts's per-file rooms, which exist for document *content*
 * sync — this exists purely so the UI can show "who's here" across the
 * whole project, not just whoever happens to be on the same file as you.
 * No document content is ever synced here, only awareness state.
 */

const MESSAGE_AWARENESS = 1;
const WS_READY_STATE_CONNECTING = 0;
const WS_READY_STATE_OPEN = 1;
const PING_TIMEOUT_MS = 30_000;

class PresenceRoom {
  // Awareness needs *a* Y.Doc to anchor its client id/clock to — its content is never read or written.
  private anchor = new Y.Doc();
  awareness = new awarenessProtocol.Awareness(this.anchor);
  conns: Map<WebSocket, Set<number>> = new Map();

  constructor() {
    this.awareness.setLocalState(null);
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, conn: WebSocket | null) => {
        const changedClients = added.concat(updated, removed);
        if (conn !== null) {
          const connControlledIds = this.conns.get(conn);
          if (connControlledIds !== undefined) {
            added.forEach((clientId) => connControlledIds.add(clientId));
            removed.forEach((clientId) => connControlledIds.delete(clientId));
          }
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
        const message = encoding.toUint8Array(encoder);
        this.conns.forEach((_, c) => send(c, message));
      }
    );
  }
}

function send(conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== WS_READY_STATE_CONNECTING && conn.readyState !== WS_READY_STATE_OPEN) return;
  try {
    conn.send(message);
  } catch {
    // connection is on its way out either way; the 'close' handler cleans up awareness state
  }
}

const rooms = new Map<string, PresenceRoom>();
function getRoom(projectId: string): PresenceRoom {
  return mapUtil.setIfUndefined(rooms, projectId, () => new PresenceRoom());
}

/** Wires one accepted WebSocket connection into the project-wide presence room for `projectId`. */
export function setupPresenceConnection(conn: WebSocket, _req: IncomingMessage, projectId: string): void {
  conn.binaryType = "arraybuffer";
  const room = getRoom(projectId);
  room.conns.set(conn, new Set());

  function closeConn(): void {
    if (room.conns.has(conn)) {
      const controlledIds = room.conns.get(conn)!;
      room.conns.delete(conn);
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(controlledIds), null);
    }
  }

  conn.on("message", (message: ArrayBuffer) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(message));
      if (decoding.readVarUint(decoder) === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
      }
    } catch (err) {
      console.error("Error handling presence message:", err);
    }
  });

  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      closeConn();
      conn.close();
      clearInterval(pingInterval);
      return;
    }
    if (room.conns.has(conn)) {
      pongReceived = false;
      try {
        conn.ping();
      } catch {
        closeConn();
        clearInterval(pingInterval);
      }
    }
  }, PING_TIMEOUT_MS);

  conn.on("close", () => {
    closeConn();
    clearInterval(pingInterval);
  });
  conn.on("pong", () => {
    pongReceived = true;
  });

  const states = room.awareness.getStates();
  if (states.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())));
    send(conn, encoding.toUint8Array(encoder));
  }
}
