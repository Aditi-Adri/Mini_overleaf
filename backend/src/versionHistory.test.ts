import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real git + real Postgres/MinIO, same pattern as compileService.test.ts —
// env vars must land before these modules are first imported anywhere.
process.env.DATABASE_URL ??= "postgres://postgres@localhost:5433/mini_overleaf_test";
process.env.S3_BUCKET ??= "mini-overleaf-test";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let versionHistoryRoot: string;
let snapshotProject: typeof import("./versionHistory.js").snapshotProject;
let listVersions: typeof import("./versionHistory.js").listVersions;
let getVersionDiff: typeof import("./versionHistory.js").getVersionDiff;
let createProject: typeof import("./projects.js").createProject;
let createBinaryFile: typeof import("./projects.js").createBinaryFile;
let updateFileContent: typeof import("./projects.js").updateFileContent;
let deleteFile: typeof import("./projects.js").deleteFile;
let pool: typeof import("./db.js").pool;

beforeAll(async () => {
  versionHistoryRoot = await mkdtemp(path.join(tmpdir(), "mini-overleaf-version-history-test-"));
  process.env.VERSION_HISTORY_ROOT = versionHistoryRoot;

  const db = await import("./db.js");
  const storage = await import("./storage.js");
  const projects = await import("./projects.js");
  const versionHistory = await import("./versionHistory.js");

  await db.runMigrations();
  await storage.ensureBucket();

  pool = db.pool;
  createProject = projects.createProject;
  createBinaryFile = projects.createBinaryFile;
  updateFileContent = projects.updateFileContent;
  deleteFile = projects.deleteFile;
  snapshotProject = versionHistory.snapshotProject;
  listVersions = versionHistory.listVersions;
  getVersionDiff = versionHistory.getVersionDiff;
}, 30_000);

afterAll(async () => {
  await pool.end();
  await rm(versionHistoryRoot, { recursive: true, force: true });
});

describe("versionHistory (integration)", () => {
  it("returns an empty list for a project with no snapshots yet", async () => {
    const { project } = await createProject("Version history — no snapshots");
    expect(await listVersions(project.id)).toEqual([]);
  });

  it("commits a first snapshot, then skips a second one when nothing changed", async () => {
    const { project } = await createProject("Version history — dedupe");
    const first = await snapshotProject(project.id, "compile");
    expect(first.committed).toBe(true);
    expect(first.hash).toMatch(/^[0-9a-f]{40}$/);

    const second = await snapshotProject(project.id, "compile");
    expect(second.committed).toBe(false);
    expect(second.hash).toBeNull();
  });

  it("commits a new snapshot after content changes, and labels manual saves distinctly", async () => {
    const { project } = await createProject("Version history — trigger labels");
    const compileSnap = await snapshotProject(project.id, "compile");
    expect(compileSnap.committed).toBe(true);

    await updateFileContent(project.mainFileId!, "\\documentclass{article}\n\\begin{document}\nedited\n\\end{document}\n");
    const manualSnap = await snapshotProject(project.id, "manual", "before big rewrite");
    expect(manualSnap.committed).toBe(true);
    expect(manualSnap.hash).not.toBe(compileSnap.hash);

    const versions = await listVersions(project.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].trigger).toBe("manual");
    expect(versions[0].message).toBe("Manual save: before big rewrite");
    expect(versions[1].trigger).toBe("compile");
    expect(versions[0].hash).toBe(manualSnap.hash);
    expect(versions[1].hash).toBe(compileSnap.hash);
  });

  it("diffs two snapshots and shows the changed line as removed/added", async () => {
    const { project } = await createProject("Version history — diff");
    await updateFileContent(project.mainFileId!, "\\documentclass{article}\n\\begin{document}\nfirst version\n\\end{document}\n");
    const before = await snapshotProject(project.id, "manual");

    await updateFileContent(project.mainFileId!, "\\documentclass{article}\n\\begin{document}\nsecond version\n\\end{document}\n");
    const after = await snapshotProject(project.id, "manual");

    const diff = await getVersionDiff(project.id, before.hash!, after.hash!);
    const mainDiff = diff.find((f) => f.path === "main.tex");
    expect(mainDiff).toBeDefined();
    expect(mainDiff!.status).toBe("modified");
    expect(mainDiff!.diffText).toContain("-first version");
    expect(mainDiff!.diffText).toContain("+second version");
  });

  it("marks a changed binary file as a binary diff with no text hunk", async () => {
    const { project } = await createProject("Version history — binary diff");
    const { listFiles } = await import("./projects.js");
    await createBinaryFile(project.id, "images/pixel.png", TINY_PNG, "image/png");
    const before = await snapshotProject(project.id, "manual");

    // Replace with a different (still tiny) PNG payload so the content genuinely changes.
    const otherPng = Buffer.concat([TINY_PNG, Buffer.from([0])]);
    const files = await listFiles(project.id);
    const imageFile = files.find((f) => f.path === "images/pixel.png")!;
    await deleteFile(project.id, imageFile.id);
    await createBinaryFile(project.id, "images/pixel.png", otherPng, "image/png");

    const after = await snapshotProject(project.id, "manual");
    const diff = await getVersionDiff(project.id, before.hash!, after.hash!);
    const imageDiff = diff.find((f) => f.path === "images/pixel.png");
    expect(imageDiff).toBeDefined();
    expect(imageDiff!.status).toBe("binary");
    expect(imageDiff!.diffText).toBe("");
  });

  it("reflects a deleted file as removed in the next snapshot's diff", async () => {
    const { project } = await createProject("Version history — deletion");
    await createBinaryFile(project.id, "images/gone.png", TINY_PNG, "image/png");
    const before = await snapshotProject(project.id, "manual");

    const files = await (await import("./projects.js")).listFiles(project.id);
    const toDelete = files.find((f) => f.path === "images/gone.png")!;
    await deleteFile(project.id, toDelete.id);
    const after = await snapshotProject(project.id, "manual");

    const diff = await getVersionDiff(project.id, before.hash!, after.hash!);
    const deleted = diff.find((f) => f.path === "images/gone.png");
    expect(deleted).toBeDefined();
    expect(deleted!.status).toBe("removed");
  });

  it("rejects non-hash version identifiers instead of shelling out with them", async () => {
    const { project } = await createProject("Version history — bad ref");
    await snapshotProject(project.id, "manual");
    await expect(getVersionDiff(project.id, "--upload-pack=x", "HEAD")).rejects.toThrow();
    await expect(getVersionDiff(project.id, "main", "HEAD")).rejects.toThrow();
  });
});
