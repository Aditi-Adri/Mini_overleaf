import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { KeyedMutex, Semaphore } from "./concurrency.js";
import { compileLatex } from "./latex.js";
import { workspaceDirFor } from "./session.js";

export interface CompileOutcome {
  ok: boolean;
  pdf?: Buffer;
  log: string;
  durationMs: number;
  cacheHit: boolean;
}

const HASH_FILE = "source.sha256";
const PDF_FILE = "main.pdf";
const TEX_FILE = "main.tex";

const sessionMutex = new KeyedMutex();
const compileSemaphore = new Semaphore(config.maxConcurrentCompiles);

function hashOf(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Compiles `source` for the given session, short-circuiting when the source
 * is byte-identical to the last successful compile (the "don't recompile
 * from scratch when nothing changed" cache). Concurrent calls for the same
 * session are serialized so tectonic never runs twice against one workspace.
 */
export async function compileForSession(sessionId: string, source: string): Promise<CompileOutcome> {
  const workspaceDir = workspaceDirFor(sessionId);

  return sessionMutex.run(sessionId, async () => {
    await mkdir(workspaceDir, { recursive: true });

    const wantedHash = hashOf(source);
    const cachedHash = await readIfExists(path.join(workspaceDir, HASH_FILE));

    if (cachedHash === wantedHash) {
      const cachedPdf = await readFile(path.join(workspaceDir, PDF_FILE)).catch(() => null);
      if (cachedPdf) {
        return { ok: true, pdf: cachedPdf, log: "", durationMs: 0, cacheHit: true };
      }
      // Hash matched but the PDF is missing (e.g. previous compile failed) — fall through and recompile.
    }

    await writeFile(path.join(workspaceDir, TEX_FILE), source, "utf8");

    const result = await compileSemaphore.run(() => compileLatex(workspaceDir));

    if (result.ok) {
      await writeFile(path.join(workspaceDir, HASH_FILE), wantedHash, "utf8");
    }

    return { ok: result.ok, pdf: result.pdf, log: result.log, durationMs: result.durationMs, cacheHit: false };
  });
}
