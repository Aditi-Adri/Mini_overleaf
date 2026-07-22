import { useEffect, useRef, useState } from "react";
import { compileProject, type CompileErrorEntry } from "../lib/api";

export type CompileStatus = "idle" | "compiling" | "success" | "error";

export interface CompilerState {
  status: CompileStatus;
  pdfData: Uint8Array | null;
  error: string | null;
  errors: CompileErrorEntry[];
  cache: "HIT" | "MISS" | null;
  durationMs: number | null;
  compiledAt: number | null;
}

const DEBOUNCE_MS = 1500;

/**
 * Debounces `trigger` (the active file's live content) and compiles the
 * *whole project* on the backend. Unlike phase 1/2, no source text is sent
 * here — the backend reads current state itself (live Yjs content where a
 * file is actively open, else its last-persisted snapshot) for every file
 * the project owns, so switching which file is "active" doesn't change what
 * gets compiled, just what triggers the debounce.
 *
 * Switching files without editing still re-fires this (the new file's
 * content differs from the previous trigger value) but that's cheap: the
 * backend's content-hash cache turns an unchanged project into an instant
 * `X-Cache: HIT` rather than a real recompile.
 */
export function useProjectCompiler(projectId: string | null, trigger: string): CompilerState {
  const [state, setState] = useState<CompilerState>({
    status: "idle",
    pdfData: null,
    error: null,
    errors: [],
    cache: null,
    durationMs: null,
    compiledAt: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const lastTriggerRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!projectId) return;
    clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      if (trigger === lastTriggerRef.current) return;
      if (trigger.trim().length === 0) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState((prev) => ({ ...prev, status: "compiling" }));

      compileProject(projectId, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          lastTriggerRef.current = trigger;

          if (result.ok) {
            setState({
              status: "success",
              pdfData: result.pdfBytes,
              error: null,
              errors: [],
              cache: result.cache,
              durationMs: result.durationMs,
              compiledAt: Date.now(),
            });
          } else {
            setState((prev) => ({ ...prev, status: "error", error: result.error, errors: result.errors, compiledAt: Date.now() }));
          }
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setState((prev) => ({ ...prev, status: "error", error: String(err), errors: [], compiledAt: Date.now() }));
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(debounceRef.current);
  }, [trigger, projectId]);

  return state;
}
