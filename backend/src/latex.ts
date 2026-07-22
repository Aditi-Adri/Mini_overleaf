import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";

export interface CompileResult {
  ok: boolean;
  pdf?: Buffer;
  log: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Runs `tectonic -X compile` against `mainFilePath` (relative to
 * `workspaceDir`, which must already contain every file the project
 * references — chapters, .bib, images) and reads back the resulting PDF.
 * Tectonic always writes `<basename-without-ext>.pdf` at the *root* of
 * `--outdir`, regardless of which subdirectory the input file lives in.
 */
export async function compileLatex(workspaceDir: string, mainFilePath: string): Promise<CompileResult> {
  const started = Date.now();
  const outputPdfName = `${path.basename(mainFilePath, path.extname(mainFilePath))}.pdf`;

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      const child = spawn(
        config.tectonicPath,
        [
          "-X",
          "compile",
          mainFilePath,
          "--outdir",
          ".",
          // Disables shell-escape and other filesystem/network side effects —
          // essential since main.tex is untrusted user input.
          "--untrusted",
        ],
        { cwd: workspaceDir, windowsHide: true }
      );

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, config.compileTimeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: `${stderr}\nFailed to start compiler: ${String(err)}`, timedOut });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    }
  );

  const durationMs = Date.now() - started;
  const log = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();

  if (result.timedOut) {
    return { ok: false, log: `Compilation timed out after ${config.compileTimeoutMs}ms.\n${log}`, durationMs, timedOut: true };
  }

  if (result.code !== 0) {
    return { ok: false, log: log || `tectonic exited with code ${result.code}`, durationMs, timedOut: false };
  }

  try {
    const { readFile } = await import("node:fs/promises");
    const pdf = await readFile(path.join(workspaceDir, outputPdfName));
    return { ok: true, pdf, log, durationMs, timedOut: false };
  } catch {
    return { ok: false, log: log || "Compiler reported success but no PDF was produced.", durationMs, timedOut: false };
  }
}
