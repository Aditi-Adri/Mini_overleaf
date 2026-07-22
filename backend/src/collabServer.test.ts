import { createServer, type Server, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_KEY, setupWSConnection } from "./collabServer.js";

// A minimal hand-rolled client speaking the same sync wire protocol as
// collabServer.ts, so this test exercises the real message exchange rather
// than trusting a library's abstraction of it.
class TestClient {
  doc = new Y.Doc();
  ws: WebSocket;
  private syncedResolve!: () => void;
  synced = new Promise<void>((resolve) => {
    this.syncedResolve = resolve;
  });

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    // The server only ever sends *its* syncStep1 (its state vector) — it
    // replies with content but never asks for it. A client that wants the
    // server's actual content has to proactively request it the same way,
    // by sending its own syncStep1 as soon as the connection opens.
    this.ws.on("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.ws.send(encoding.toUint8Array(encoder));
    });

    this.ws.on("message", (data: ArrayBuffer) => {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const messageType = decoding.readVarUint(decoder);
      if (messageType !== 0) return; // ignore awareness messages in this test

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) {
        this.ws.send(encoding.toUint8Array(encoder));
      }
      this.syncedResolve();
    });

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // don't echo updates that came from the server back to it
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
    });
  }

  waitForText(predicate: (text: string) => boolean, timeoutMs = 5000): Promise<string> {
    const current = this.doc.getText(CONTENT_KEY).toString();
    if (predicate(current)) return Promise.resolve(current);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.doc.off("update", check);
        reject(new Error(`Timed out waiting for text condition. Last value: ${JSON.stringify(this.doc.getText(CONTENT_KEY).toString())}`));
      }, timeoutMs);
      const check = () => {
        const text = this.doc.getText(CONTENT_KEY).toString();
        if (predicate(text)) {
          clearTimeout(timer);
          this.doc.off("update", check);
          resolve(text);
        }
      };
      this.doc.on("update", check);
    });
  }

  close() {
    this.ws.close();
  }
}

let server: Server;
let wss: WebSocketServer;
let baseUrl: string;
let workspacesRoot: string;

beforeAll(async () => {
  workspacesRoot = await mkdtemp(path.join(tmpdir(), "mini-overleaf-collab-test-"));
  process.env.WORKSPACES_ROOT = workspacesRoot;

  server = createServer();
  wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (conn: WebSocket, req: IncomingMessage, docId: string) => setupWSConnection(conn, req, docId));

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "", "http://internal").pathname;
    const docId = pathname.slice(1);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, docId);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a bound TCP address");
  baseUrl = `ws://localhost:${address.port}`;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workspacesRoot, { recursive: true, force: true });
});

const openClients: TestClient[] = [];
function connect(docId: string): TestClient {
  const client = new TestClient(`${baseUrl}/${docId}`);
  openClients.push(client);
  return client;
}

afterEach(() => {
  while (openClients.length > 0) openClients.pop()?.close();
});

// Generous timeouts: these run alongside compileService.test.ts's real
// tectonic-spawning tests in the same suite, and CPU contention from that
// can push otherwise-fast WebSocket round trips past vitest's 5s default.
const TEST_TIMEOUT_MS = 15_000;

describe("collaboration WebSocket server", () => {
  it(
    "seeds a brand-new room with the starter template",
    async () => {
      const client = connect("11111111-1111-4111-8111-111111111111");
      const text = await client.waitForText((t) => t.includes("\\documentclass"));
      expect(text).toContain("\\begin{document}");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "propagates a local edit from one client to another in the same room",
    async () => {
      const docId = "22222222-2222-4222-8222-222222222222";
      const alice = connect(docId);
      const bob = connect(docId);

      // Wait for the room's async seed to actually reach each client's local
      // doc — not just for the initial handshake (`synced`) to complete —
      // before editing. Otherwise alice's edit and the server's seed insert
      // are genuinely concurrent CRDT operations with no causal order
      // between them, and Yjs's (entirely correct) tie-break for concurrent
      // same-position inserts doesn't guarantee alice's text ends up first.
      const seeded = (t: string) => t.includes("\\documentclass");
      await alice.waitForText(seeded, TEST_TIMEOUT_MS);
      await bob.waitForText(seeded, TEST_TIMEOUT_MS);

      alice.doc.getText(CONTENT_KEY).insert(0, "hello from alice ");

      const bobText = await bob.waitForText((t) => t.startsWith("hello from alice "), TEST_TIMEOUT_MS);
      expect(bobText.startsWith("hello from alice ")).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "keeps two rooms independent",
    async () => {
      const roomA = connect("33333333-3333-4333-8333-333333333333");
      const roomB = connect("44444444-4444-4444-8444-444444444444");

      await roomA.synced;
      await roomB.synced;

      roomA.doc.getText(CONTENT_KEY).insert(0, "only in room A");

      // Give any (incorrect) cross-room broadcast a chance to arrive before asserting it didn't.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(roomB.doc.getText(CONTENT_KEY).toString()).not.toContain("only in room A");
    },
    TEST_TIMEOUT_MS
  );
});
