import { useEffect, useRef, useState } from "react";
import { compileLatex } from "../lib/api";

export type CompileStatus = "idle" | "compiling" | "success" | "error";

export interface CompilerState {
  status: CompileStatus;
  pdfData: Uint8Array | null;
  error: string | null;
  cache: "HIT" | "MISS" | null;
  durationMs: number | null;
  compiledAt: number | null;
}

const DEBOUNCE_MS = 1500;

/**
 * Debounces `source` and compiles it on the backend. Waits DEBOUNCE_MS after
 * the last keystroke before firing, so a fast typist doesn't trigger a
 * compile per character. Stale in-flight requests are aborted whenever a
 * newer one starts, so a slow older response can never clobber a newer PDF.
 */
export function useLatexCompiler(source: string): CompilerState {
  const [state, setState] = useState<CompilerState>({
    status: "idle",
    pdfData: null,
    error: null,
    cache: null,
    durationMs: null,
    compiledAt: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const lastCompiledSourceRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      if (source === lastCompiledSourceRef.current) return;
      if (source.trim().length === 0) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState((prev) => ({ ...prev, status: "compiling" }));

      compileLatex(source, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          lastCompiledSourceRef.current = source;

          if (result.ok) {
            setState({
              status: "success",
              pdfData: result.pdfBytes,
              error: null,
              cache: result.cache,
              durationMs: result.durationMs,
              compiledAt: Date.now(),
            });
          } else {
            setState((prev) => ({
              ...prev,
              status: "error",
              error: result.error,
              compiledAt: Date.now(),
            }));
          }
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setState((prev) => ({ ...prev, status: "error", error: String(err), compiledAt: Date.now() }));
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(debounceRef.current);
  }, [source]);

  return state;
}
