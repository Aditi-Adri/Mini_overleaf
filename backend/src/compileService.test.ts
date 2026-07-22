import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// This test drives the real tectonic binary end-to-end (write .tex -> compile -> read .pdf),
// so it needs actual env setup before compileService/config are imported. Config reads
// process.env at module-load time, so imports below are dynamic and happen in beforeAll,
// after the env vars are in place.
const here = path.dirname(fileURLToPath(import.meta.url));
const localWindowsTectonic = path.resolve(here, "..", "..", "tools", "tectonic.exe");
const tectonicPath = process.env.TECTONIC_PATH ?? (existsSync(localWindowsTectonic) ? localWindowsTectonic : "tectonic");

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const GOOD_SOURCE = "\\documentclass{article}\n\\begin{document}\nHello, mini-overleaf!\n\\end{document}\n";
const BAD_SOURCE = "\\documentclass{article}\n\\begin{document}\n\\thiscommanddoesnotexist\n\\end{document}\n";

let workspacesRoot: string;
let compileForSession: typeof import("./compileService.js").compileForSession;
let tectonicAvailable = true;

beforeAll(async () => {
  workspacesRoot = await mkdtemp(path.join(tmpdir(), "mini-overleaf-test-"));
  process.env.WORKSPACES_ROOT = workspacesRoot;
  process.env.TECTONIC_PATH = tectonicPath;

  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(tectonicPath, ["--version"], { stdio: "ignore" });
  } catch {
    tectonicAvailable = false;
  }

  ({ compileForSession } = await import("./compileService.js"));
}, 30_000);

afterAll(async () => {
  await rm(workspacesRoot, { recursive: true, force: true });
});

describe.skipIf(!tectonicAvailable)("compileForSession (integration)", () => {
  it("compiles valid LaTeX into a PDF", async () => {
    const result = await compileForSession(SESSION_ID, GOOD_SOURCE);
    expect(result.ok).toBe(true);
    expect(result.cacheHit).toBe(false);
    expect(result.pdf?.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 120_000);

  it("serves an identical second request from cache without recompiling", async () => {
    const result = await compileForSession(SESSION_ID, GOOD_SOURCE);
    expect(result.ok).toBe(true);
    expect(result.cacheHit).toBe(true);
    expect(result.durationMs).toBe(0);
  }, 120_000);

  it("returns the compiler's error text on failure instead of throwing", async () => {
    const result = await compileForSession(SESSION_ID, BAD_SOURCE);
    expect(result.ok).toBe(false);
    expect(result.log.toLowerCase()).toContain("undefined control sequence");
  }, 120_000);
});
