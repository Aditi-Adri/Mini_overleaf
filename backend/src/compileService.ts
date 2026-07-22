import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { KeyedMutex, Semaphore } from "./concurrency.js";
import { compileLatex } from "./latex.js";
import { workspaceDirFor } from "./session.js";
import { getBinaryContent, getFile, getProject, listFiles } from "./projects.js";
import { getLiveText } from "./collabServer.js";
import { snapshotProject } from "./versionHistory.js";

export interface CompileOutcome {
  ok: boolean;
  pdf?: Buffer;
  log: string;
  durationMs: number;
  cacheHit: boolean;
}

// Neither can collide with a real project file — isValidRelativePath
// requires paths to start with an alphanumeric/underscore, never a dot.
const HASH_FILE = ".project.sha256";
const MANIFEST_FILE = ".binaries.json";

interface BinaryManifestEntry {
  path: string;
  updatedAt: string;
  sizeBytes: number;
}

const projectMutex = new KeyedMutex();
const compileSemaphore = new Semaphore(config.maxConcurrentCompiles);

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(workspaceDir: string): Promise<Record<string, BinaryManifestEntry>> {
  const raw = await readIfExists(path.join(workspaceDir, MANIFEST_FILE));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, BinaryManifestEntry>;
  } catch {
    return {};
  }
}

function outputPdfNameFor(mainFilePath: string): string {
  return `${path.basename(mainFilePath, path.extname(mainFilePath))}.pdf`;
}

/**
 * Compiles a whole project: every file the project owns is materialized
 * into a persistent per-project workspace directory at its project-relative
 * path (so `\input{sections/intro}`, `\bibliography{refs}`,
 * `\includegraphics{images/x.png}` all resolve), then tectonic runs against
 * the project's designated main file.
 *
 * Text files prefer their live, currently-being-edited Yjs content over the
 * last-persisted Postgres snapshot — see collabServer.ts's getLiveText —
 * so a compile always reflects the freshest keystrokes, not just what's
 * been debounce-saved so far.
 */
export async function compileProject(projectId: string): Promise<CompileOutcome> {
  const workspaceDir = workspaceDirFor(projectId);

  return projectMutex.run(projectId, async () => {
    const project = await getProject(projectId);
    if (!project) {
      return { ok: false, log: "Project not found.", durationMs: 0, cacheHit: false };
    }
    if (!project.mainFileId) {
      return { ok: false, log: "This project has no main file set — pick one in the file tree.", durationMs: 0, cacheHit: false };
    }

    const files = await listFiles(projectId);
    const mainFile = files.find((f) => f.id === project.mainFileId);
    if (!mainFile) {
      return { ok: false, log: "The project's main file no longer exists.", durationMs: 0, cacheHit: false };
    }

    await mkdir(workspaceDir, { recursive: true });

    // Gather every file's current content up front, sorted for a
    // deterministic combined hash. Text files need their actual content
    // read regardless (to write to disk); binary files use cheap metadata
    // (no S3 read) for the cache check, and only get fetched from S3 below
    // if something actually changed.
    const textContents = new Map<string, string>();
    const hasher = createHash("sha256");
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      hasher.update(file.path).update("\0");
      if (file.kind === "text") {
        const live = getLiveText(file.id);
        const content = live ?? (await getFile(file.id))?.content ?? "";
        textContents.set(file.id, content);
        hasher.update(content).update("\0");
      } else {
        hasher.update(`${file.updatedAt}:${file.sizeBytes}`).update("\0");
      }
    }
    const wantedHash = hasher.digest("hex");

    const cachedHash = await readIfExists(path.join(workspaceDir, HASH_FILE));
    if (cachedHash === wantedHash) {
      const cachedPdf = await readFile(path.join(workspaceDir, outputPdfNameFor(mainFile.path))).catch(() => null);
      if (cachedPdf) {
        return { ok: true, pdf: cachedPdf, log: "", durationMs: 0, cacheHit: true };
      }
      // Hash matched but the PDF is missing (e.g. previous compile failed) — fall through and recompile.
    }

    // Something changed — materialize every file. Binaries consult a small
    // on-disk manifest first: unchanged ones are left alone entirely, and
    // ones that only *moved* (renamed, content identical) are renamed
    // locally instead of re-fetched — only genuinely new/changed binary
    // content costs an S3 round trip.
    const previousManifest = await readManifest(workspaceDir);
    const nextManifest: Record<string, BinaryManifestEntry> = {};

    for (const file of files) {
      const filePath = path.join(workspaceDir, file.path);
      await mkdir(path.dirname(filePath), { recursive: true });

      if (file.kind === "text") {
        await writeFile(filePath, textContents.get(file.id) ?? "", "utf8");
        continue;
      }

      const previous = previousManifest[file.id];
      const contentUnchanged = previous?.updatedAt === file.updatedAt && previous?.sizeBytes === file.sizeBytes;

      if (contentUnchanged && previous.path === file.path && (await fileExists(filePath))) {
        nextManifest[file.id] = previous;
        continue;
      }

      if (contentUnchanged) {
        const oldPath = path.join(workspaceDir, previous.path);
        if (await fileExists(oldPath)) {
          await rename(oldPath, filePath);
          nextManifest[file.id] = { path: file.path, updatedAt: file.updatedAt, sizeBytes: file.sizeBytes };
          continue;
        }
      }

      const full = await getFile(file.id);
      if (full?.storageKey) {
        await writeFile(filePath, await getBinaryContent(full.storageKey));
        nextManifest[file.id] = { path: file.path, updatedAt: file.updatedAt, sizeBytes: file.sizeBytes };
      }
    }

    await writeFile(path.join(workspaceDir, MANIFEST_FILE), JSON.stringify(nextManifest), "utf8");

    const result = await compileSemaphore.run(() => compileLatex(workspaceDir, mainFile.path));

    if (result.ok) {
      await writeFile(path.join(workspaceDir, HASH_FILE), wantedHash, "utf8");
      try {
        // Awaited so "every successful compile gets a snapshot" is a real
        // guarantee, not a race — but a version-history hiccup still must
        // never fail the compile response the user is actually waiting on.
        await snapshotProject(projectId, "compile");
      } catch (err) {
        console.error(`Failed to snapshot version history for project ${projectId}:`, err);
      }
    }

    return { ok: result.ok, pdf: result.pdf, log: result.log, durationMs: result.durationMs, cacheHit: false };
  });
}
