import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // Root directory where each session gets its own isolated compile workspace.
  workspacesRoot: process.env.WORKSPACES_ROOT ?? path.resolve(here, "..", "workspaces"),
  // Path to the tectonic binary. Overridable so Docker (`tectonic` on PATH)
  // and local Windows dev (a downloaded .exe) can both work.
  tectonicPath: process.env.TECTONIC_PATH ?? "tectonic",
  // Reject source bodies larger than this (bytes) — keeps compiles fast and bounded.
  maxSourceBytes: Number(process.env.MAX_SOURCE_BYTES ?? 300_000),
  // Hard kill a compile that runs longer than this.
  compileTimeoutMs: Number(process.env.COMPILE_TIMEOUT_MS ?? 60_000),
  // Max number of compiles allowed to run at once across all sessions.
  maxConcurrentCompiles: Number(process.env.MAX_CONCURRENT_COMPILES ?? 4),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres@localhost:5433/mini_overleaf",

  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "mini-overleaf",
    accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    // MinIO (and most non-AWS S3-compatible stores) need path-style URLs
    // (http://host/bucket/key) rather than AWS's virtual-hosted style
    // (http://bucket.host/key).
    forcePathStyle: true,
  },

  // Max upload size for binary project assets (images, PDFs figures, etc.).
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  // Debounce before a Yjs room's live text is persisted back to Postgres.
  persistDebounceMs: Number(process.env.PERSIST_DEBOUNCE_MS ?? 2000),
};
