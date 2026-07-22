import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { LATEX_LANGUAGE_ID, registerLatexLanguage } from "../lib/latexLanguage";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 14,
  lineNumbers: "on" as const,
  wordWrap: "on" as const,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  tabSize: 2,
  padding: { top: 12 },
};

export function LatexEditor({ value, onChange }: Props) {
  const handleBeforeMount: BeforeMount = (monaco) => {
    registerLatexLanguage(monaco);
  };

  const handleMount: OnMount = (editor) => {
    editor.focus();
  };

  return (
    <Editor
      language={LATEX_LANGUAGE_ID}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      theme="vs-dark"
      options={EDITOR_OPTIONS}
    />
  );
}
