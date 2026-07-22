import { spawn } from "node:child_process";
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { KeyedMutex } from "./concurrency.js";
import { getBinaryContent, getFile, listFiles } from "./projects.js";
import { getLiveText } from "./collabServer.js";

// Lives outside the tracked working tree (repo-local exclude, not .gitignore
// — never shown in `git status`, never a candidate for `git add -A`) so this
// bookkeeping file never ends up as a phantom entry in the user's history.
const MANIFEST_FILE = ".version-history-manifest.json";

interface BinaryManifestEntry {
  path: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface VersionEntry {
  hash: string;
  createdAt: string;
  message: string;
  trigger: "compile" | "manual";
}

export interface VersionDiffFile {
  path: string;
  status: "added" | "removed" | "modified" | "binary";
  /** Unified-diff body for this file only (hunk headers + content lines) — no `diff --git`/index/---/+++ metadata. Empty for binary files. */
  diffText: string;
}

export const COMMIT_HASH_RE = /^[0-9a-f]{40}$/;

// This app's own commits, not the user's — a fixed identity is intentional
// so `git log` doesn't depend on host git config being set up at all.
const GIT_AUTHOR_ARGS = ["-c", "user.name=mini-overleaf", "-c", "user.email=snapshots@mini-overleaf.local"];

const repoMutex = new KeyedMutex();

function versionHistoryDirFor(projectId: string): string {
  const dir = path.resolve(config.versionHistoryRoot, projectId);
  const root = path.resolve(config.versionHistoryRoot);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error("Resolved version-history path escapes version-history root");
  }
  return dir;
}

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.gitPath, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

async function hasGitDir(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(projectId: string): Promise<string> {
  const dir = versionHistoryDirFor(projectId);
  await mkdir(dir, { recursive: true });
  if (!(await hasGitDir(dir))) {
    const result = await runGit(["init", "-q", "-b", "main"], dir);
    if (result.code !== 0) throw new Error(`git init failed: ${result.stderr || result.stdout}`);
    await appendFile(path.join(dir, ".git", "info", "exclude"), `${MANIFEST_FILE}\n`, "utf8");
  }
  return dir;
}

async function readManifest(dir: string): Promise<Record<string, BinaryManifestEntry>> {
  try {
    return JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8")) as Record<string, BinaryManifestEntry>;
  } catch {
    return {};
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

/**
 * Writes every current project file to disk and removes any previously-
 * tracked file that no longer exists in the project (renames/deletes).
 * Binary files consult a small manifest first — same idea as
 * compileService's compile-workspace cache — so an unrelated text edit
 * doesn't re-download every image from S3 on every single compile.
 */
async function materialize(dir: string, projectId: string): Promise<void> {
  const files = await listFiles(projectId);
  const currentPaths = new Set(files.map((f) => f.path));

  const tracked = await runGit(["ls-files"], dir);
  for (const trackedPath of tracked.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (!currentPaths.has(trackedPath)) {
      await rm(path.join(dir, trackedPath), { force: true });
    }
  }

  const previousManifest = await readManifest(dir);
  const nextManifest: Record<string, BinaryManifestEntry> = {};

  for (const file of files) {
    const filePath = path.join(dir, file.path);
    await mkdir(path.dirname(filePath), { recursive: true });

    if (file.kind === "text") {
      const live = getLiveText(file.id);
      const content = live ?? (await getFile(file.id))?.content ?? "";
      await writeFile(filePath, content, "utf8");
      continue;
    }

    const previous = previousManifest[file.id];
    const contentUnchanged = previous?.updatedAt === file.updatedAt && previous?.sizeBytes === file.sizeBytes;

    if (contentUnchanged && previous.path === file.path && (await fileExists(filePath))) {
      nextManifest[file.id] = previous;
      continue;
    }

    if (contentUnchanged) {
      const oldPath = path.join(dir, previous.path);
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

  await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(nextManifest), "utf8");
}

/**
 * Materializes the project's current state and commits it if anything
 * changed since the last snapshot. A no-op (returns `committed: false`)
 * when nothing differs — e.g. recompiling without edits, or two overlapping
 * triggers racing on the same content — so history stays meaningful rather
 * than filling with empty commits.
 */
export async function snapshotProject(
  projectId: string,
  trigger: "compile" | "manual",
  label?: string
): Promise<{ committed: boolean; hash: string | null }> {
  return repoMutex.run(projectId, async () => {
    const dir = await ensureRepo(projectId);
    await materialize(dir, projectId);

    const add = await runGit(["add", "-A"], dir);
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);

    const status = await runGit(["status", "--porcelain"], dir);
    if (!status.stdout.trim()) {
      return { committed: false, hash: null };
    }

    const trimmedLabel = label?.trim();
    const message = trigger === "manual" ? `Manual save${trimmedLabel ? `: ${trimmedLabel}` : ""}` : "Compile snapshot";
    const commit = await runGit([...GIT_AUTHOR_ARGS, "commit", "-q", "-m", message], dir);
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);

    const rev = await runGit(["rev-parse", "HEAD"], dir);
    return { committed: true, hash: rev.stdout.trim() };
  });
}

export async function listVersions(projectId: string): Promise<VersionEntry[]> {
  const dir = versionHistoryDirFor(projectId);
  if (!(await hasGitDir(dir))) return [];

  const log = await runGit(["log", "--format=%H%x1f%aI%x1f%s"], dir);
  if (log.code !== 0) return []; // e.g. repo exists but has zero commits yet

  return log.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, createdAt, message] = line.split("\x1f");
      return { hash, createdAt, message, trigger: message.startsWith("Manual save") ? "manual" : "compile" } satisfies VersionEntry;
    });
}

function parseUnifiedDiff(raw: string): VersionDiffFile[] {
  const files: VersionDiffFile[] = [];
  const blocks = raw.split(/^diff --git /m).slice(1);

  for (const block of blocks) {
    const headerLine = block.slice(0, block.indexOf("\n"));
    const match = headerLine.match(/^a\/(.+?) b\/(.+)$/);
    const filePath = match ? match[2] : headerLine.trim();

    let status: VersionDiffFile["status"];
    if (/^new file mode/m.test(block)) status = "added";
    else if (/^deleted file mode/m.test(block)) status = "removed";
    else if (/^Binary files /m.test(block)) status = "binary";
    else status = "modified";

    const bodyLines: string[] = [];
    let inHunk = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("@@")) inHunk = true;
      if (inHunk) bodyLines.push(line);
    }
    files.push({ path: filePath, status, diffText: bodyLines.join("\n") });
  }

  return files;
}

export async function getVersionDiff(projectId: string, from: string, to: string): Promise<VersionDiffFile[]> {
  if (!COMMIT_HASH_RE.test(from) || !COMMIT_HASH_RE.test(to)) {
    throw new Error("Version hashes must be full 40-character commit hashes.");
  }
  const dir = versionHistoryDirFor(projectId);
  if (!(await hasGitDir(dir))) return [];

  for (const rev of [from, to]) {
    const check = await runGit(["cat-file", "-e", `${rev}^{commit}`], dir);
    if (check.code !== 0) throw new Error(`Unknown version: ${rev}`);
  }

  const diff = await runGit(["diff", "--no-color", from, to], dir);
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  return parseUnifiedDiff(diff.stdout);
}
