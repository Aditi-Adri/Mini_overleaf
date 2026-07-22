import { spawn } from "node:child_process";
import { config } from "./config.js";

export interface CompileResult {
  ok: boolean;
  pdf?: Buffer;
  log: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Runs `tectonic -X compile` against main.tex inside `workspaceDir` and reads
 * back main.pdf on success. The workspace directory is reused across calls
 * for the same session, which is what lets Tectonic's own resource cache
 * (fonts, packages, format files) stay warm between edits.
 */
export async function compileLatex(workspaceDir: string): Promise<CompileResult> {
  const started = Date.now();

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      const child = spawn(
        config.tectonicPath,
        [
          "-X",
          "compile",
          "main.tex",
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
    const pdf = await readFile(`${workspaceDir}/main.pdf`);
    return { ok: true, pdf, log, durationMs, timedOut: false };
  } catch {
    return { ok: false, log: log || "Compiler reported success but no PDF was produced.", durationMs, timedOut: false };
  }
}
