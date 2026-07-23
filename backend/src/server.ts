import cors from "cors";
import express, { type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { compileProject } from "./compileService.js";
import { parseCompileErrors } from "./errorParser.js";
import { getVersionDiff, listVersions, snapshotProject } from "./versionHistory.js";
import { extractZip, pickMainFile } from "./zipImport.js";
import {
  createSession,
  deleteSession,
  getSessionUser,
  isProjectSavedByUser,
  listSavedProjects,
  saveProjectForUser,
  unsaveProjectForUser,
  upsertUser,
  verifyGoogleIdToken,
  type User,
} from "./auth.js";
import { isValidSessionId } from "./session.js";
import { setupWSConnection } from "./collabServer.js";
import { runMigrations } from "./db.js";
import { ensureBucket } from "./storage.js";
import { setupPresenceConnection } from "./presenceServer.js";
import { resolveUpgradeTarget } from "./wsAuth.js";
import {
  createBinaryFile,
  createProject,
  createTextFile,
  deleteFile,
  getBinaryContent,
  getFile,
  getProject,
  isValidRelativePath,
  listFiles,
  renameFile,
  setMainFile,
  verifyEditToken,
  type FileWithContent,
  type Project,
} from "./projects.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });
const uploadZip = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxZipUploadBytes } });

app.use(cors({ origin: config.corsOrigin, exposedHeaders: ["X-Cache", "X-Compile-Ms"] }));
// JSON-escaping a backslash-heavy LaTeX source can nearly double its size,
// so this transport limit is set well above config.maxSourceBytes (the
// actual enforced limit, checked where relevant below).
app.use(express.json({ limit: "2mb" }));

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      console.error("Request failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error." });
    });
  };
}

async function requireProject(projectId: string, res: Response): Promise<Project | null> {
  const project = await getProject(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return null;
  }
  return project;
}

async function requireOwnedFile(projectId: string, fileId: string, res: Response): Promise<FileWithContent | null> {
  if (!isValidSessionId(fileId)) {
    res.status(400).json({ error: "Invalid file id." });
    return null;
  }
  const file = await getFile(fileId);
  if (!file || file.projectId !== projectId) {
    res.status(404).json({ error: "File not found." });
    return null;
  }
  return file;
}

/**
 * The project id in the URL grants read access to anyone who has it
 * (that's what makes a project shareable at all). Mutating it — creating,
 * editing, uploading, deleting, renaming, or changing the main file —
 * additionally requires this header to match the project's edit_token,
 * which is handed out once at creation time and otherwise never exposed by
 * a read endpoint. See projects.ts's createProject/verifyEditToken.
 */
async function requireEditAccess(projectId: string, req: Request, res: Response): Promise<boolean> {
  const token = req.header("x-edit-token");
  if (!(await verifyEditToken(projectId, token))) {
    res.status(403).json({ error: "Edit access required — use the project's edit link to get one." });
    return false;
  }
  return true;
}

/** Google sign-in is entirely separate from a project's own edit_token — it identifies *who's asking*, not what they're allowed to touch. */
async function requireSessionUser(req: Request, res: Response): Promise<User | null> {
  const user = await getSessionUser(req.header("x-session-token"));
  if (!user) {
    res.status(401).json({ error: "Sign in required." });
    return null;
  }
  return user;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "23505";
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// --- Google sign-in — entirely optional, additive layer. Nothing here
// gates or changes the existing anonymous edit-token/link flow; a user who
// never signs in never touches any of these routes. ---

app.post(
  "/api/auth/google",
  asyncHandler(async (req, res) => {
    const idToken = req.body?.idToken;
    if (typeof idToken !== "string" || !idToken) {
      res.status(400).json({ error: "Missing idToken." });
      return;
    }
    let profile;
    try {
      profile = await verifyGoogleIdToken(idToken);
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : "Could not verify that sign-in." });
      return;
    }
    const user = await upsertUser(profile);
    const session = await createSession(user.id);
    res.json({ token: session.token, expiresAt: session.expiresAt, user });
  })
);

app.post(
  "/api/auth/logout",
  asyncHandler(async (req, res) => {
    const token = req.header("x-session-token");
    if (token) await deleteSession(token);
    res.json({ ok: true });
  })
);

app.get(
  "/api/me",
  asyncHandler(async (req, res) => {
    const user = await requireSessionUser(req, res);
    if (!user) return;
    res.json({ user });
  })
);

app.get(
  "/api/me/projects",
  asyncHandler(async (req, res) => {
    const user = await requireSessionUser(req, res);
    if (!user) return;
    res.json({ projects: await listSavedProjects(user.id) });
  })
);

app.post(
  "/api/projects/:projectId/save",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const project = await requireProject(projectId, res);
    if (!project) return;
    const user = await requireSessionUser(req, res);
    if (!user) return;

    // Only stored if it actually verifies — saving never *grants* edit
    // access, it just remembers access the caller already legitimately had.
    const claimedEditToken = req.body?.editToken;
    const editToken = typeof claimedEditToken === "string" && (await verifyEditToken(projectId, claimedEditToken)) ? claimedEditToken : null;

    await saveProjectForUser(user.id, projectId, editToken);
    res.status(201).json({ saved: true, canEdit: editToken !== null });
  })
);

app.delete(
  "/api/projects/:projectId/save",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const user = await requireSessionUser(req, res);
    if (!user) return;
    await unsaveProjectForUser(user.id, projectId);
    res.json({ saved: false });
  })
);

app.get(
  "/api/projects/:projectId/saved",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const user = await requireSessionUser(req, res);
    if (!user) return;
    res.json({ saved: await isProjectSavedByUser(user.id, projectId) });
  })
);

app.post(
  "/api/projects",
  asyncHandler(async (req, res) => {
    const rawName = req.body?.name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 200) : undefined;
    const { project, editToken } = await createProject(name);
    const files = await listFiles(project.id);
    // editToken is returned here and only here — the creator's client is
    // responsible for hanging onto it (see frontend/src/lib/room.ts).
    res.status(201).json({ project, files, editToken });
  })
);

app.post(
  "/api/projects/upload-zip",
  uploadZip.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });
      return;
    }

    let extraction: ReturnType<typeof extractZip>;
    try {
      extraction = extractZip(req.file.buffer);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const rawName = req.body?.name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 200) : undefined;
    const { project, editToken } = await createProject(name, { seedDemo: false });

    for (const file of extraction.files) {
      if (file.kind === "text") {
        await createTextFile(project.id, file.path, file.content.toString("utf8"));
      } else {
        await createBinaryFile(project.id, file.path, file.content, file.contentType);
      }
    }

    const mainPath = pickMainFile(extraction.files);
    const files = await listFiles(project.id);
    const mainFile = mainPath ? files.find((f) => f.path === mainPath) : undefined;
    if (mainFile) await setMainFile(project.id, mainFile.id);

    res.status(201).json({
      project: { ...project, mainFileId: mainFile?.id ?? null },
      files,
      editToken,
      skipped: extraction.skipped,
    });
  })
);

app.get(
  "/api/projects/:projectId",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const project = await requireProject(projectId, res);
    if (!project) return;
    const files = await listFiles(projectId);
    res.json({ project, files });
  })
);

app.patch(
  "/api/projects/:projectId",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const project = await requireProject(projectId, res);
    if (!project) return;
    if (!(await requireEditAccess(projectId, req, res))) return;

    const { mainFileId } = req.body ?? {};
    if (typeof mainFileId !== "string" || !isValidSessionId(mainFileId)) {
      res.status(400).json({ error: "mainFileId must be a valid file id." });
      return;
    }
    const file = await getFile(mainFileId);
    if (!file || file.projectId !== projectId || file.kind !== "text") {
      res.status(400).json({ error: "mainFileId must reference a text file in this project." });
      return;
    }

    await setMainFile(projectId, mainFileId);
    res.json({ project: await getProject(projectId) });
  })
);

app.post(
  "/api/projects/:projectId/files",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const project = await requireProject(projectId, res);
    if (!project) return;
    if (!(await requireEditAccess(projectId, req, res))) return;

    const { path: filePath, content } = req.body ?? {};
    if (!isValidRelativePath(filePath)) {
      res.status(400).json({ error: "Invalid file path." });
      return;
    }

    try {
      const file = await createTextFile(projectId, filePath, typeof content === "string" ? content : "");
      const files = await listFiles(projectId);
      res.status(201).json({ file, files });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "A file already exists at that path." });
        return;
      }
      throw err;
    }
  })
);

app.post(
  "/api/projects/:projectId/files/upload",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const project = await requireProject(projectId, res);
    if (!project) return;
    if (!(await requireEditAccess(projectId, req, res))) return;

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });
      return;
    }

    const rawPath = req.body?.path;
    const filePath = typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : req.file.originalname;
    if (!isValidRelativePath(filePath)) {
      res.status(400).json({ error: "Invalid file path." });
      return;
    }

    try {
      const file = await createBinaryFile(projectId, filePath, req.file.buffer, req.file.mimetype || "application/octet-stream");
      const files = await listFiles(projectId);
      res.status(201).json({ file, files });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "A file already exists at that path." });
        return;
      }
      throw err;
    }
  })
);

app.get(
  "/api/projects/:projectId/files/:fileId/raw",
  asyncHandler(async (req, res) => {
    const { projectId, fileId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const file = await requireOwnedFile(projectId, fileId, res);
    if (!file) return;

    if (file.kind === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(file.content ?? "");
      return;
    }
    if (!file.storageKey) {
      res.status(404).json({ error: "File has no stored content." });
      return;
    }
    res.setHeader("Content-Type", file.contentType || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(await getBinaryContent(file.storageKey));
  })
);

app.patch(
  "/api/projects/:projectId/files/:fileId",
  asyncHandler(async (req, res) => {
    const { projectId, fileId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const file = await requireOwnedFile(projectId, fileId, res);
    if (!file) return;
    if (!(await requireEditAccess(projectId, req, res))) return;

    const { path: newPath } = req.body ?? {};
    if (!isValidRelativePath(newPath)) {
      res.status(400).json({ error: "Invalid path." });
      return;
    }

    try {
      const renamed = await renameFile(fileId, newPath);
      const files = await listFiles(projectId);
      res.json({ file: renamed, files });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "A file already exists at that path." });
        return;
      }
      throw err;
    }
  })
);

app.delete(
  "/api/projects/:projectId/files/:fileId",
  asyncHandler(async (req, res) => {
    const { projectId, fileId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const file = await requireOwnedFile(projectId, fileId, res);
    if (!file) return;
    if (!(await requireEditAccess(projectId, req, res))) return;

    await deleteFile(projectId, fileId);
    res.json({ files: await listFiles(projectId) });
  })
);

app.post(
  "/api/projects/:projectId/compile",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }

    const result = await compileProject(projectId);
    res.setHeader("X-Cache", result.cacheHit ? "HIT" : "MISS");
    res.setHeader("X-Compile-Ms", String(result.durationMs));

    if (result.ok && result.pdf) {
      res.setHeader("Content-Type", "application/pdf");
      res.status(200).send(result.pdf);
      return;
    }
    res.status(422).json({ error: result.log || "Compilation failed.", errors: parseCompileErrors(result.log ?? "") });
  })
);

// Version history is read-only informational data (like the raw-file
// endpoint) — anyone with the project id can browse/diff it. Only creating a
// new manual snapshot is a mutation, so only that route is edit-gated.
app.get(
  "/api/projects/:projectId/versions",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const project = await requireProject(projectId, res);
    if (!project) return;
    res.json({ versions: await listVersions(projectId) });
  })
);

app.get(
  "/api/projects/:projectId/versions/diff",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const project = await requireProject(projectId, res);
    if (!project) return;

    const { from, to } = req.query;
    if (typeof from !== "string" || typeof to !== "string") {
      res.status(400).json({ error: "Query params 'from' and 'to' are required." });
      return;
    }
    try {
      res.json({ files: await getVersionDiff(projectId, from, to) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  })
);

app.post(
  "/api/projects/:projectId/versions",
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!isValidSessionId(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const project = await requireProject(projectId, res);
    if (!project) return;
    if (!(await requireEditAccess(projectId, req, res))) return;

    const rawLabel = req.body?.label;
    const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim().slice(0, 200) : undefined;
    const result = await snapshotProject(projectId, "manual", label);
    res.status(201).json(result);
  })
);

// Must come after the routes: catches multer errors (e.g. file-too-large)
// that occur inside upload.single(), which throws before asyncHandler's
// try/catch is in scope. Two different multer instances (regular file
// upload vs. zip import) have different size limits, so the message picks
// the right one based on which route was hit.
app.use((err: unknown, req: Request, res: Response, next: (err?: unknown) => void) => {
  if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
    const limit = req.path.endsWith("/upload-zip") ? config.maxZipUploadBytes : config.maxUploadBytes;
    res.status(413).json({ error: `File is too large (max ${limit} bytes).` });
    return;
  }
  next(err);
});

async function main() {
  // Both are idempotent — safe to run on every boot, in dev and in Docker,
  // against a schema/bucket that may already exist.
  await runMigrations();
  await ensureBucket();

  const server = app.listen(config.port, () => {
    console.log(`mini-overleaf backend listening on http://localhost:${config.port}`);
  });

  // Two WebSocket endpoints, both on this same HTTP server (no separate
  // port), so they work through the same dev proxy / nginx config as
  // everything else:
  //   /yjs/<fileId>       — per-file document collaboration (collabServer.ts)
  //   /presence/<projectId> — project-wide "who's here" (presenceServer.ts)
  // Browsers can't set custom headers on a WebSocket handshake, so the edit
  // token travels as a query param (?token=...) instead of X-Edit-Token.
  // Without a valid token for the relevant project, neither upgrade is
  // accepted at all — read-only visitors get a REST-only, non-live view
  // (see requireEditAccess for the equivalent REST-side check).
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (conn: WebSocket, req: IncomingMessage, fileId: string) => setupWSConnection(conn, req, fileId));

  const presenceWss = new WebSocketServer({ noServer: true });
  presenceWss.on("connection", (conn: WebSocket, req: IncomingMessage, projectId: string) => setupPresenceConnection(conn, req, projectId));

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? "", "http://internal");
      const target = await resolveUpgradeTarget(url.pathname, url.searchParams.get("token"));

      if (!target) {
        socket.destroy();
        return;
      }
      if (target.kind === "yjs") {
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, target.fileId));
      } else {
        presenceWss.handleUpgrade(request, socket, head, (ws) => presenceWss.emit("connection", ws, request, target.projectId));
      }
    })().catch((err: unknown) => {
      console.error("WebSocket upgrade failed:", err);
      socket.destroy();
    });
  });
}

main().catch((err: unknown) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
