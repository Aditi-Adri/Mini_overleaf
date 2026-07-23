import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://postgres@localhost:5433/mini_overleaf_test";

let verifyGoogleIdToken: typeof import("./auth.js").verifyGoogleIdToken;
let upsertUser: typeof import("./auth.js").upsertUser;
let createSession: typeof import("./auth.js").createSession;
let getSessionUser: typeof import("./auth.js").getSessionUser;
let deleteSession: typeof import("./auth.js").deleteSession;
let saveProjectForUser: typeof import("./auth.js").saveProjectForUser;
let unsaveProjectForUser: typeof import("./auth.js").unsaveProjectForUser;
let listSavedProjects: typeof import("./auth.js").listSavedProjects;
let isProjectSavedByUser: typeof import("./auth.js").isProjectSavedByUser;
let createProject: typeof import("./projects.js").createProject;
let pool: typeof import("./db.js").pool;
let config: typeof import("./config.js").config;

const fakeProfile = (suffix: string) => ({
  id: `google-test-sub-${suffix}`,
  email: `test-${suffix}@example.com`,
  name: `Test User ${suffix}`,
  pictureUrl: null,
});

beforeAll(async () => {
  const db = await import("./db.js");
  const projects = await import("./projects.js");
  const auth = await import("./auth.js");
  const configModule = await import("./config.js");

  await db.runMigrations();

  pool = db.pool;
  config = configModule.config;
  createProject = projects.createProject;
  verifyGoogleIdToken = auth.verifyGoogleIdToken;
  upsertUser = auth.upsertUser;
  createSession = auth.createSession;
  getSessionUser = auth.getSessionUser;
  deleteSession = auth.deleteSession;
  saveProjectForUser = auth.saveProjectForUser;
  unsaveProjectForUser = auth.unsaveProjectForUser;
  listSavedProjects = auth.listSavedProjects;
  isProjectSavedByUser = auth.isProjectSavedByUser;
}, 30_000);

afterAll(async () => {
  await pool.end();
});

describe("verifyGoogleIdToken", () => {
  it("refuses to verify anything when GOOGLE_CLIENT_ID isn't configured", async () => {
    const original = config.googleClientId;
    config.googleClientId = null;
    try {
      await expect(verifyGoogleIdToken("anything")).rejects.toThrow(/not configured/i);
    } finally {
      config.googleClientId = original;
    }
  });

  it("rejects a garbage token instead of crashing", async () => {
    const original = config.googleClientId;
    config.googleClientId = "test-client-id.apps.googleusercontent.com";
    try {
      await expect(verifyGoogleIdToken("not-a-real-jwt")).rejects.toThrow();
    } finally {
      config.googleClientId = original;
    }
  });
});

describe("users and sessions (integration)", () => {
  it("upserts a user idempotently, updating profile fields on conflict", async () => {
    const profile = fakeProfile("upsert");
    const first = await upsertUser(profile);
    expect(first.email).toBe(profile.email);

    const updated = await upsertUser({ ...profile, name: "Renamed" });
    expect(updated.id).toBe(first.id);
    expect(updated.name).toBe("Renamed");
  });

  it("creates a session that resolves back to the right user, and rejects an unknown token", async () => {
    const user = await upsertUser(fakeProfile("session"));
    const session = await createSession(user.id);
    expect(session.token).toBeTruthy();

    const resolved = await getSessionUser(session.token);
    expect(resolved?.id).toBe(user.id);

    expect(await getSessionUser("not-a-real-token")).toBeNull();
    expect(await getSessionUser(null)).toBeNull();
  });

  it("stops resolving a session after logout", async () => {
    const user = await upsertUser(fakeProfile("logout"));
    const session = await createSession(user.id);
    expect(await getSessionUser(session.token)).not.toBeNull();

    await deleteSession(session.token);
    expect(await getSessionUser(session.token)).toBeNull();
  });
});

describe("saved projects (integration)", () => {
  it("saves a project without an edit token as view-only", async () => {
    const user = await upsertUser(fakeProfile("save-view"));
    const { project } = await createProject("Save test — view only");

    await saveProjectForUser(user.id, project.id, null);
    const list = await listSavedProjects(user.id);
    const entry = list.find((p) => p.id === project.id);
    expect(entry).toBeDefined();
    expect(entry!.canEdit).toBe(false);
    expect(entry!.editToken).toBeNull();
  });

  it("saves a project with a real edit token as editable, and lists newest-first", async () => {
    const user = await upsertUser(fakeProfile("save-edit"));
    const { project: p1, editToken: t1 } = await createProject("Save test — first");
    await saveProjectForUser(user.id, p1.id, t1);
    await new Promise((r) => setTimeout(r, 10));
    const { project: p2, editToken: t2 } = await createProject("Save test — second");
    await saveProjectForUser(user.id, p2.id, t2);

    const list = await listSavedProjects(user.id);
    expect(list[0].id).toBe(p2.id);
    expect(list[1].id).toBe(p1.id);
    expect(list.find((p) => p.id === p1.id)!.canEdit).toBe(true);
  });

  it("reports isProjectSavedByUser correctly and supports unsaving", async () => {
    const user = await upsertUser(fakeProfile("save-toggle"));
    const { project } = await createProject("Save test — toggle");

    expect(await isProjectSavedByUser(user.id, project.id)).toBe(false);
    await saveProjectForUser(user.id, project.id, null);
    expect(await isProjectSavedByUser(user.id, project.id)).toBe(true);

    await unsaveProjectForUser(user.id, project.id);
    expect(await isProjectSavedByUser(user.id, project.id)).toBe(false);
  });

  it("saving the same project twice does not duplicate or downgrade an existing edit token", async () => {
    const user = await upsertUser(fakeProfile("save-dedupe"));
    const { project, editToken } = await createProject("Save test — dedupe");

    await saveProjectForUser(user.id, project.id, editToken);
    await saveProjectForUser(user.id, project.id, null); // re-saving without a token shouldn't erase the one already stored

    const list = await listSavedProjects(user.id);
    const matches = list.filter((p) => p.id === project.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].canEdit).toBe(true);
  });
});
