import { createServer, type Server, type IncomingMessage } from "node:http";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// This test drives real Postgres + MinIO (see projects.ts/db.ts/storage.ts),
// so env vars must be set before those modules are first imported anywhere
// in the process — hence the dynamic imports inside beforeAll rather than
// static imports up top.
process.env.DATABASE_URL ??= "postgres://postgres@localhost:5433/mini_overleaf_test";
process.env.S3_BUCKET ??= "mini-overleaf-test";

const CONTENT_KEY = "content";

// Generous timeouts: these run alongside compileService.test.ts's real
// tectonic-spawning tests in the same suite, and CPU contention from that
// can push otherwise-fast round trips past vitest's 5s default.
const TEST_TIMEOUT_MS = 15_000;

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

  waitForText(predicate: (text: string) => boolean, timeoutMs = TEST_TIMEOUT_MS): Promise<string> {
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
let createProject: typeof import("./projects.js").createProject;
let createTextFile: typeof import("./projects.js").createTextFile;
let pool: typeof import("./db.js").pool;

beforeAll(async () => {
  const { runMigrations, pool: dbPool } = await import("./db.js");
  const { ensureBucket } = await import("./storage.js");
  const projects = await import("./projects.js");
  const { setupWSConnection } = await import("./collabServer.js");

  pool = dbPool;
  createProject = projects.createProject;
  createTextFile = projects.createTextFile;

  await runMigrations();
  await ensureBucket();

  server = createServer();
  wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (conn: WebSocket, req: IncomingMessage, fileId: string) => setupWSConnection(conn, req, fileId));

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "", "http://internal").pathname;
    const fileId = pathname.slice(1);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, fileId);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a bound TCP address");
  baseUrl = `ws://localhost:${address.port}`;
}, 30_000);

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

const openClients: TestClient[] = [];
function connect(fileId: string): TestClient {
  const client = new TestClient(`${baseUrl}/${fileId}`);
  openClients.push(client);
  return client;
}

afterEach(() => {
  while (openClients.length > 0) openClients.pop()?.close();
});

describe("collaboration WebSocket server", () => {
  it(
    "seeds a room from the file's content in Postgres",
    async () => {
      const { project } = await createProject("Collab test project");
      const client = connect(project.mainFileId!);
      const text = await client.waitForText((t) => t.includes("\\documentclass"));
      expect(text).toContain("\\begin{document}");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "propagates a local edit from one client to another editing the same file",
    async () => {
      const { project } = await createProject("Collab test project");
      const file = await createTextFile(project.id, "notes.tex", "");
      const alice = connect(file.id);
      const bob = connect(file.id);

      await alice.synced;
      await bob.synced;

      alice.doc.getText(CONTENT_KEY).insert(0, "hello from alice ");

      const bobText = await bob.waitForText((t) => t.startsWith("hello from alice "));
      expect(bobText.startsWith("hello from alice ")).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "keeps two files' rooms independent",
    async () => {
      const { project } = await createProject("Collab test project");
      const fileA = await createTextFile(project.id, "a.tex", "");
      const fileB = await createTextFile(project.id, "b.tex", "");
      const roomA = connect(fileA.id);
      const roomB = connect(fileB.id);

      await roomA.synced;
      await roomB.synced;

      roomA.doc.getText(CONTENT_KEY).insert(0, "only in file A");

      // Give any (incorrect) cross-room broadcast a chance to arrive before asserting it didn't.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(roomB.doc.getText(CONTENT_KEY).toString()).not.toContain("only in file A");
    },
    TEST_TIMEOUT_MS
  );
});
