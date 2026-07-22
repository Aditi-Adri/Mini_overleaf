import type { IncomingMessage } from "node:http";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as mapUtil from "lib0/map";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import { getFile, updateFileContent } from "./projects.js";

// Adapted from y-websocket's (pre-3.0) reference server implementation —
// that logic was removed from the `y-websocket` package itself in v3, which
// is now client-only. The replacement, @y/websocket-server, depends on the
// still-unreleased Yjs v14 (dist-tag "next"), which would put a pre-release
// engine behind the stable v13 client libraries (y-monaco, y-websocket) this
// app uses elsewhere. Implementing directly against the stable, documented
// y-protocols wire protocol avoids that mismatch entirely.
//
// One room per *file* (not per project) — a room's name is a file id. Room
// content is seeded from, and debounce-persisted back to, Postgres (see
// projects.ts), which is what makes it survive server restarts and is what
// the compile step reads when nobody currently has that file open.

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
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(fileId: string) {
    super({ gc: true });
    this.name = fileId;
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

      this.schedulePersist();
    });
  }

  private schedulePersist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.flushPersist(), config.persistDebounceMs);
  }

  /** Writes the room's current text straight to Postgres, skipping the debounce wait. */
  flushPersist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    void updateFileContent(this.name, this.getText(CONTENT_KEY).toString()).catch((err) => {
      console.error(`Failed to persist file ${this.name}:`, err);
    });
  }
}

const docs = new Map<string, WSSharedDoc>();

/** A room's document only needs seeding once, from Postgres, the moment it's first created. */
async function seedDoc(doc: WSSharedDoc, fileId: string): Promise<void> {
  const text = doc.getText(CONTENT_KEY);
  if (text.length > 0) return;

  let seed = "";
  try {
    const file = await getFile(fileId);
    if (file?.kind === "text" && file.content) seed = file.content;
  } catch (err) {
    console.error(`Failed to load seed content for file ${fileId}:`, err);
  }

  if (text.length > 0 || seed.length === 0) return; // a client may have already typed while we were reading the DB
  doc.transact(() => {
    if (text.length === 0) text.insert(0, seed);
  });
}

function getYDoc(fileId: string): WSSharedDoc {
  return mapUtil.setIfUndefined(docs, fileId, () => {
    const doc = new WSSharedDoc(fileId);
    docs.set(fileId, doc);
    void seedDoc(doc, fileId);
    return doc;
  });
}

/** The current live text for a file, if a collaboration room for it is active — used by the compiler to prefer in-flight edits over the last-persisted Postgres snapshot. */
export function getLiveText(fileId: string): string | null {
  const doc = docs.get(fileId);
  return doc ? doc.getText(CONTENT_KEY).toString() : null;
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
    // Nobody's left editing this file for the moment — don't leave up to
    // persistDebounceMs of their edits stranded in memory only.
    if (doc.conns.size === 0) doc.flushPersist();
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

/** Wires one accepted WebSocket connection into the shared doc for `fileId`. */
export function setupWSConnection(conn: WebSocket, _req: IncomingMessage, fileId: string): void {
  conn.binaryType = "arraybuffer";
  const doc = getYDoc(fileId);
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
