import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://postgres@localhost:5433/mini_overleaf_test";
process.env.S3_BUCKET ??= "mini-overleaf-test";

let resolveUpgradeTarget: typeof import("./wsAuth.js").resolveUpgradeTarget;
let createProject: typeof import("./projects.js").createProject;
let createTextFile: typeof import("./projects.js").createTextFile;
let pool: typeof import("./db.js").pool;

beforeAll(async () => {
  const db = await import("./db.js");
  const storage = await import("./storage.js");
  const projects = await import("./projects.js");
  const wsAuth = await import("./wsAuth.js");

  await db.runMigrations();
  await storage.ensureBucket();

  pool = db.pool;
  createProject = projects.createProject;
  createTextFile = projects.createTextFile;
  resolveUpgradeTarget = wsAuth.resolveUpgradeTarget;
}, 30_000);

afterAll(async () => {
  await pool.end();
});

describe("resolveUpgradeTarget", () => {
  it("accepts a /yjs/<fileId> upgrade with the correct project edit token", async () => {
    const { project, editToken } = await createProject("wsAuth test");
    const target = await resolveUpgradeTarget(`/yjs/${project.mainFileId}`, editToken);
    expect(target).toEqual({ kind: "yjs", fileId: project.mainFileId });
  });

  it("rejects a /yjs/<fileId> upgrade with a wrong token", async () => {
    const { project } = await createProject("wsAuth test");
    const target = await resolveUpgradeTarget(`/yjs/${project.mainFileId}`, "not-the-real-token");
    expect(target).toBeNull();
  });

  it("rejects a /yjs/<fileId> upgrade with no token at all", async () => {
    const { project } = await createProject("wsAuth test");
    const target = await resolveUpgradeTarget(`/yjs/${project.mainFileId}`, null);
    expect(target).toBeNull();
  });

  it("rejects a /yjs/<fileId> upgrade for a file id that doesn't exist", async () => {
    const target = await resolveUpgradeTarget("/yjs/11111111-1111-4111-8111-111111111111", "anything");
    expect(target).toBeNull();
  });

  it("scopes the token to its own project — another project's token doesn't work", async () => {
    const { project: projectA } = await createProject("project A");
    const { editToken: tokenB } = await createProject("project B");
    const target = await resolveUpgradeTarget(`/yjs/${projectA.mainFileId}`, tokenB);
    expect(target).toBeNull();
  });

  it("accepts a /presence/<projectId> upgrade with the correct token", async () => {
    const { project, editToken } = await createProject("wsAuth presence test");
    const target = await resolveUpgradeTarget(`/presence/${project.id}`, editToken);
    expect(target).toEqual({ kind: "presence", projectId: project.id });
  });

  it("rejects a /presence/<projectId> upgrade with a wrong token", async () => {
    const { project } = await createProject("wsAuth presence test");
    const target = await resolveUpgradeTarget(`/presence/${project.id}`, "nope");
    expect(target).toBeNull();
  });

  it("a file's token check follows renames/new files within the same project", async () => {
    const { project, editToken } = await createProject("wsAuth new file test");
    const file = await createTextFile(project.id, "extra.tex", "");
    const target = await resolveUpgradeTarget(`/yjs/${file.id}`, editToken);
    expect(target).toEqual({ kind: "yjs", fileId: file.id });
  });

  it("rejects unrecognized paths outright", async () => {
    const target = await resolveUpgradeTarget("/something-else/123", "anything");
    expect(target).toBeNull();
  });
});
