import { getSessionId } from "./session";

// Empty string keeps requests relative (/api/...), which works both with the
// Vite dev server proxy and with the Docker/nginx setup. Override via
// VITE_API_BASE_URL for other deployments.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export type CompileResult =
  | { ok: true; pdfBytes: Uint8Array; cache: "HIT" | "MISS"; durationMs: number }
  | { ok: false; error: string };

export async function compileLatex(source: string, signal: AbortSignal): Promise<CompileResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/compile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": getSessionId(),
      },
      body: JSON.stringify({ source }),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: `Could not reach the compile server: ${String(err)}` };
  }

  const cache = response.headers.get("X-Cache") === "HIT" ? "HIT" : "MISS";
  const durationMs = Number(response.headers.get("X-Compile-Ms") ?? 0);

  if (response.ok) {
    const pdfBytes = new Uint8Array(await response.arrayBuffer());
    return { ok: true, pdfBytes, cache, durationMs };
  }

  let message = `Compile request failed (HTTP ${response.status}).`;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // response wasn't JSON — keep the generic message
  }
  return { ok: false, error: message };
}
