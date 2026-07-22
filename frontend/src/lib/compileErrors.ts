import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import type { CompileErrorEntry } from "./api";

const MARKER_OWNER = "compile-errors";

function normalize(p: string): string {
  return p.replace(/^\.\//, "");
}

/** Tectonic sometimes reports \input-ed files without their .tex extension, so matching tries both forms. */
export function errorsForFile(errors: CompileErrorEntry[], filePath: string | null): CompileErrorEntry[] {
  if (!filePath) return [];
  const path = normalize(filePath);
  const withoutExt = path.replace(/\.tex$/i, "");
  return errors.filter((e) => {
    if (!e.file) return false;
    const f = normalize(e.file);
    return f === path || f === withoutExt || `${f}.tex` === path;
  });
}

/** Underlines the reported line (whole-line, since Tectonic's log gives no column) with a hoverable error marker. */
export function applyErrorMarkers(monaco: Monaco, model: MonacoEditorNS.ITextModel, errors: CompileErrorEntry[]): void {
  const markers = errors
    .filter((e): e is CompileErrorEntry & { line: number } => e.line !== null && e.line >= 1 && e.line <= model.getLineCount())
    .map((e) => ({
      severity: monaco.MarkerSeverity.Error,
      message: e.message,
      startLineNumber: e.line,
      startColumn: 1,
      endLineNumber: e.line,
      endColumn: model.getLineMaxColumn(e.line),
    }));
  monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
}
