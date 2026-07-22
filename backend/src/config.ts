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
};
