import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// This test drives the real tectonic binary end-to-end against real
// Postgres + MinIO, so env vars must be set before those modules are first
// imported anywhere in the process — hence the dynamic imports in beforeAll.
process.env.DATABASE_URL ??= "postgres://postgres@localhost:5433/mini_overleaf_test";
process.env.S3_BUCKET ??= "mini-overleaf-test";

const here = path.dirname(fileURLToPath(import.meta.url));
const localWindowsTectonic = path.resolve(here, "..", "..", "tools", "tectonic.exe");
const tectonicPath = process.env.TECTONIC_PATH ?? (existsSync(localWindowsTectonic) ? localWindowsTectonic : "tectonic");

// A well-known minimal valid 1x1 transparent PNG, used to test that binary
// project assets round-trip through S3 and actually get picked up by
// \includegraphics — not just stored.
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let workspacesRoot: string;
let versionHistoryRoot: string;
let compileProject: typeof import("./compileService.js").compileProject;
let createProject: typeof import("./projects.js").createProject;
let createBinaryFile: typeof import("./projects.js").createBinaryFile;
let createTextFile: typeof import("./projects.js").createTextFile;
let updateFileContent: typeof import("./projects.js").updateFileContent;
let setMainFile: typeof import("./projects.js").setMainFile;
let listFiles: typeof import("./projects.js").listFiles;
let extractZip: typeof import("./zipImport.js").extractZip;
let pickMainFile: typeof import("./zipImport.js").pickMainFile;
let storageModule: typeof import("./storage.js");
let pool: typeof import("./db.js").pool;
let tectonicAvailable = true;

beforeAll(async () => {
  workspacesRoot = await mkdtemp(path.join(tmpdir(), "mini-overleaf-compile-test-"));
  versionHistoryRoot = await mkdtemp(path.join(tmpdir(), "mini-overleaf-compile-test-versions-"));
  process.env.WORKSPACES_ROOT = workspacesRoot;
  process.env.VERSION_HISTORY_ROOT = versionHistoryRoot;
  process.env.TECTONIC_PATH = tectonicPath;

  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(tectonicPath, ["--version"], { stdio: "ignore" });
  } catch {
    tectonicAvailable = false;
  }

  const db = await import("./db.js");
  const storage = await import("./storage.js");
  const projects = await import("./projects.js");
  const compileService = await import("./compileService.js");
  const zipImport = await import("./zipImport.js");

  await db.runMigrations();
  await storage.ensureBucket();

  pool = db.pool;
  storageModule = storage;
  compileProject = compileService.compileProject;
  createProject = projects.createProject;
  createBinaryFile = projects.createBinaryFile;
  createTextFile = projects.createTextFile;
  updateFileContent = projects.updateFileContent;
  setMainFile = projects.setMainFile;
  listFiles = projects.listFiles;
  extractZip = zipImport.extractZip;
  pickMainFile = zipImport.pickMainFile;
}, 30_000);

afterAll(async () => {
  await pool.end();
  await rm(workspacesRoot, { recursive: true, force: true });
  await rm(versionHistoryRoot, { recursive: true, force: true });
});

describe.skipIf(!tectonicAvailable)("compileProject (integration)", () => {
  it(
    "compiles the seeded multi-file demo project (\\input + bibliography) into a PDF",
    async () => {
      const { project } = await createProject("Compile test — demo");
      const result = await compileProject(project.id);
      expect(result.ok).toBe(true);
      expect(result.cacheHit).toBe(false);
      expect(result.pdf?.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    },
    120_000
  );

  it(
    "commits a version-history snapshot after a successful compile, but not on a cache-hit recompile",
    async () => {
      const { listVersions } = await import("./versionHistory.js");
      const { project } = await createProject("Compile test — version snapshot");

      await compileProject(project.id); // fresh compile
      const afterFirst = await listVersions(project.id);
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].trigger).toBe("compile");

      await compileProject(project.id); // identical — served from cache, no new snapshot
      const afterSecond = await listVersions(project.id);
      expect(afterSecond).toHaveLength(1);
    },
    120_000
  );

  it(
    "serves an identical second compile from cache without recompiling",
    async () => {
      const { project } = await createProject("Compile test — cache");
      await compileProject(project.id); // warm the cache
      const result = await compileProject(project.id);
      expect(result.ok).toBe(true);
      expect(result.cacheHit).toBe(true);
      expect(result.durationMs).toBe(0);
    },
    120_000
  );

  it(
    "returns the compiler's error text when the main file has a syntax error, instead of throwing",
    async () => {
      const { project } = await createProject("Compile test — broken");
      await updateFileContent(
        project.mainFileId!,
        "\\documentclass{article}\n\\begin{document}\n\\thiscommanddoesnotexist\n\\end{document}\n"
      );
      const result = await compileProject(project.id);
      expect(result.ok).toBe(false);
      expect(result.log.toLowerCase()).toContain("undefined control sequence");
    },
    120_000
  );

  it(
    "materializes an uploaded binary image from object storage and compiles it in via \\includegraphics",
    async () => {
      const { project } = await createProject("Compile test — image");
      await createBinaryFile(project.id, "images/pixel.png", MINIMAL_PNG, "image/png");
      await updateFileContent(
        project.mainFileId!,
        "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\includegraphics[width=1cm]{images/pixel.png}\n\\end{document}\n"
      );

      const result = await compileProject(project.id);
      expect(result.ok).toBe(true);
      expect(result.pdf?.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    },
    120_000
  );

  it(
    "does not re-fetch an unchanged binary from object storage when only text changed",
    async () => {
      const { project } = await createProject("Compile test — binary cache");
      await createBinaryFile(project.id, "images/pixel.png", MINIMAL_PNG, "image/png");
      const withImage = (body: string) =>
        `\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n${body}\n\\includegraphics[width=1cm]{images/pixel.png}\n\\end{document}\n`;

      await updateFileContent(project.mainFileId!, withImage("First version."));
      const first = await compileProject(project.id);
      expect(first.ok).toBe(true);

      const getObjectSpy = vi.spyOn(storageModule, "getObject");
      await updateFileContent(project.mainFileId!, withImage("Edited — only the text changed."));
      const second = await compileProject(project.id);

      expect(second.ok).toBe(true);
      expect(second.cacheHit).toBe(false); // text did change, so this isn't a full cache hit...
      expect(getObjectSpy).not.toHaveBeenCalled(); // ...but the untouched binary should never hit S3 again
      getObjectSpy.mockRestore();
    },
    120_000
  );

  it(
    "compiles cleanly end-to-end from a realistic multi-file zip (wrapper folder, \\input, \\includegraphics, bibliography)",
    async () => {
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip();
      // A wrapper folder like a real zip export would have — extraction
      // must strip this so paths land as sections/intro.tex, not
      // MyThesis/sections/intro.tex.
      zip.addFile(
        "MyThesis/main.tex",
        Buffer.from(
          "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\input{sections/intro}\n\\includegraphics[width=1cm]{images/pixel.png}\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n"
        )
      );
      zip.addFile("MyThesis/sections/intro.tex", Buffer.from("\\section{Intro}\nCited work~\\cite{knuth1984texbook}.\n"));
      zip.addFile(
        "MyThesis/references.bib",
        Buffer.from("@book{knuth1984texbook,\n  author = {Donald E. Knuth},\n  title = {The TeXbook},\n  year = {1984}\n}\n")
      );
      zip.addFile("MyThesis/images/pixel.png", MINIMAL_PNG);

      const { files: extracted, skipped } = extractZip(zip.toBuffer());
      expect(skipped).toEqual([]);
      expect(extracted.map((f) => f.path).sort()).toEqual([
        "images/pixel.png",
        "main.tex",
        "references.bib",
        "sections/intro.tex",
      ]);

      const { project } = await createProject("Zip import test", { seedDemo: false });
      for (const file of extracted) {
        if (file.kind === "text") {
          await createTextFile(project.id, file.path, file.content.toString("utf8"));
        } else {
          await createBinaryFile(project.id, file.path, file.content, file.contentType);
        }
      }
      const mainPath = pickMainFile(extracted);
      expect(mainPath).toBe("main.tex");
      const projectFiles = await listFiles(project.id);
      const mainFile = projectFiles.find((f) => f.path === mainPath)!;
      await setMainFile(project.id, mainFile.id);

      const result = await compileProject(project.id);
      expect(result.ok).toBe(true);
      expect(result.pdf?.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    },
    120_000
  );
});
