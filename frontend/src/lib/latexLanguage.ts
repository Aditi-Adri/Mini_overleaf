import type { Monaco } from "@monaco-editor/react";

export const LATEX_LANGUAGE_ID = "latex";

/**
 * Registers a minimal Monarch tokenizer for LaTeX. Monaco has no built-in
 * LaTeX mode, so this hand-rolled grammar covers what CV/article documents
 * actually use: comments, commands, braces, and math mode, so the editor
 * doesn't read as a plain textarea.
 */
export function registerLatexLanguage(monaco: Monaco) {
  if (monaco.languages.getLanguages().some((lang: { id: string }) => lang.id === LATEX_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: LATEX_LANGUAGE_ID, extensions: [".tex"], aliases: ["LaTeX"] });

  monaco.languages.setLanguageConfiguration(LATEX_LANGUAGE_ID, {
    comments: { lineComment: "%" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(LATEX_LANGUAGE_ID, {
    tokenizer: {
      root: [
        [/%.*$/, "comment"],
        [/\\(documentclass|usepackage|begin|end)\b/, "keyword.control"],
        [/\\[a-zA-Z@]+\*?/, "keyword"],
        [/\\./, "keyword"],
        [/\$\$/, { token: "string", next: "@displayMath" }],
        [/\$/, { token: "string", next: "@inlineMath" }],
        [/[{}]/, "delimiter.curly"],
        [/[[\]]/, "delimiter.square"],
        [/[&_^#]/, "operator"],
      ],
      inlineMath: [
        [/\$/, { token: "string", next: "@pop" }],
        [/\\[a-zA-Z@]+\*?/, "keyword"],
        [/[^$\\]+/, "string"],
      ],
      displayMath: [
        [/\$\$/, { token: "string", next: "@pop" }],
        [/\\[a-zA-Z@]+\*?/, "keyword"],
        [/[^$\\]+/, "string"],
      ],
    },
  });
}
