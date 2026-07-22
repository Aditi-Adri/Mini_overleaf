import type { CompilerState } from "../hooks/useLatexCompiler";

function formatTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString();
}

export function StatusBar({ status, cache, durationMs, compiledAt }: CompilerState) {
  return (
    <div className={`status-bar status-bar--${status}`}>
      <span className="status-dot" aria-hidden="true" />
      <span className="status-text">
        {status === "idle" && "Waiting for input"}
        {status === "compiling" && "Compiling…"}
        {status === "success" && "Compiled successfully"}
        {status === "error" && "Compile failed"}
      </span>
      {status !== "compiling" && cache && (
        <span className="status-meta">
          {cache === "HIT" ? "served from cache" : `${durationMs}ms`} · {formatTime(compiledAt)}
        </span>
      )}
    </div>
  );
}
