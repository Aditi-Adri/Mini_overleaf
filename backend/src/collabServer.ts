import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as mapUtil from "lib0/map";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import type { WebSocket } from "ws";
import { DEFAULT_DOCUMENT } from "./defaultDocument.js";
import { workspaceDirFor } from "./session.js";

// Adapted from y-websocket's (pre-3.0) reference server implementation —
// that logic was removed from the `y-websocket` package itself in v3, which
// is now client-only. The replacement, @y/websocket-server, depends on the
// still-unreleased Yjs v14 (dist-tag "next"), which would put a pre-release
// engine behind the stable v13 client libraries (y-monaco, y-websocket) this
// app uses elsewhere. Implementing directly against the stable, documented
// y-protocols wire protocol avoids that mismatch entirely.
//
// Persistence/HTTP-callback support from the original reference is dropped —
// out of scope here — and replaced with room seeding (see seedDoc below).

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const WS_READY_STATE_CONNECTING = 0;
const WS_READY_STATE_OPEN = 1;

const PING_TIMEOUT_MS = 30_000;

/** The shared type name both this server and the frontend's MonacoBinding read/write. */
export const CONTENT_KEY = "content";

class WSSharedDoc extends Y.Doc {
  name: string;
  conns: Map<WebSocket, Set<number>> = new Map();
  awareness: awarenessProtocol.Awareness;

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
    this.awareness = new awarenessProtocol.Awareness(this);
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
        this.conns.forEach((_, c) => send(this, c, message));
      }
    );

    this.on("update", (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      this.conns.forEach((_, conn) => send(this, conn, message));
    });
  }
}

const docs = new Map<string, WSSharedDoc>();

/**
 * A room's document only needs seeding once, the moment it's first created —
 * from the last successful compile on disk if this room has been used
 * before (e.g. the process just restarted), otherwise the starter template,
 * so nobody joins a completely blank document.
 */
async function seedDoc(doc: WSSharedDoc, docName: string): Promise<void> {
  const text = doc.getText(CONTENT_KEY);
  if (text.length > 0) return;

  let seed = DEFAULT_DOCUMENT;
  try {
    const workspaceDir = workspaceDirFor(docName);
    seed = await readFile(path.join(workspaceDir, "main.tex"), "utf8");
  } catch {
    // No prior compile for this room — fall back to the starter template.
  }

  if (text.length > 0) return; // a client may have already typed while we were reading disk
  doc.transact(() => {
    if (text.length === 0) text.insert(0, seed);
  });
}

function getYDoc(docName: string): WSSharedDoc {
  return mapUtil.setIfUndefined(docs, docName, () => {
    const doc = new WSSharedDoc(docName);
    docs.set(docName, doc);
    void seedDoc(doc, docName);
    return doc;
  });
}

function send(doc: WSSharedDoc, conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== WS_READY_STATE_CONNECTING && conn.readyState !== WS_READY_STATE_OPEN) {
    closeConn(doc, conn);
    return;
  }
  try {
    conn.send(message, (err) => {
      if (err != null) closeConn(doc, conn);
    });
  } catch {
    closeConn(doc, conn);
  }
}

function closeConn(doc: WSSharedDoc, conn: WebSocket): void {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn)!;
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null);
  }
  conn.close();
}

function messageListener(conn: WebSocket, doc: WSSharedDoc, message: Uint8Array): void {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case MESSAGE_SYNC:
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        // A reply with only the message-type byte and nothing else carries no
        // information — skip sending it.
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      case MESSAGE_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn);
        break;
    }
  } catch (err) {
    console.error("Error handling Yjs message:", err);
  }
}

/** Wires one accepted WebSocket connection into the shared doc for `docName`. */
export function setupWSConnection(conn: WebSocket, _req: IncomingMessage, docName: string): void {
  conn.binaryType = "arraybuffer";
  const doc = getYDoc(docName);
  doc.conns.set(conn, new Set());

  conn.on("message", (message: ArrayBuffer) => messageListener(conn, doc, new Uint8Array(message)));

  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) closeConn(doc, conn);
      clearInterval(pingInterval);
      return;
    }
    if (doc.conns.has(conn)) {
      pongReceived = false;
      try {
        conn.ping();
      } catch {
        closeConn(doc, conn);
        clearInterval(pingInterval);
      }
    }
  }, PING_TIMEOUT_MS);

  conn.on("close", () => {
    closeConn(doc, conn);
    clearInterval(pingInterval);
  });
  conn.on("pong", () => {
    pongReceived = true;
  });

  // Initial sync handshake: send our state vector so the client can compute
  // and send back exactly what we're missing.
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  send(doc, conn, encoding.toUint8Array(encoder));

  const awarenessStates = doc.awareness.getStates();
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys()))
    );
    send(doc, conn, encoding.toUint8Array(awarenessEncoder));
  }
}
