import type { CompileErrorEntry } from "../lib/api";

interface Props {
  error: string;
  errors: CompileErrorEntry[];
}

/** Friendly, parsed view of a failed compile — falls back to the raw log (collapsed) when parsing found nothing structured. */
export function CompileErrorPanel({ error, errors }: Props) {
  return (
    <div className="compile-error-panel">
      {errors.length > 0 ? (
        <ul className="compile-error-list">
          {errors.map((entry, i) => (
            <li key={i} className="compile-error-item">
              <span className="compile-error-location">{entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ""}` : "compiler"}</span>
              <span className="compile-error-message">{entry.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="compile-error-fallback">The compiler reported a failure but it couldn't be parsed into a specific line — see the full log below.</p>
      )}
      <details className="compile-error-raw">
        <summary>Show full compiler log</summary>
        <pre>{error}</pre>
      </details>
    </div>
  );
}
