import { describe, expect, it } from "vitest";
import { parseCompileErrors } from "./errorParser.js";

// These logs are verbatim captures from a real local Tectonic run against
// deliberately broken .tex files (see the phase-4 investigation), not
// hand-written guesses at the format.
describe("parseCompileErrors", () => {
  it("parses an undefined control sequence error", () => {
    const log = [
      "Fontconfig error: Cannot load default config file: No such file: (null)",
      "error: bad.tex:3: Undefined control sequence",
      "error: halted on potentially-recoverable error as specified",
      "",
      'note: "version 2" Tectonic command-line interface activated',
      "note: Running TeX ...",
    ].join("\n");

    expect(parseCompileErrors(log)).toEqual([{ file: "bad.tex", line: 3, message: "Undefined control sequence" }]);
  });

  it("parses a missing-file error with a nested path", () => {
    const log = ["error: with-image.tex:4: Unable to load picture or PDF file 'panda.JPG'", "error: halted on potentially-recoverable error as specified"].join(
      "\n"
    );
    expect(parseCompileErrors(log)).toEqual([
      { file: "with-image.tex", line: 4, message: "Unable to load picture or PDF file 'panda.JPG'" },
    ]);
  });

  it("parses a missing-package error", () => {
    const log = "error: bad.tex:3: ! LaTeX Error: File `thispackagedoesnotexist12345.sty' not found.";
    expect(parseCompileErrors(log)).toEqual([
      { file: "bad.tex", line: 3, message: "! LaTeX Error: File `thispackagedoesnotexist12345.sty' not found." },
    ]);
  });

  it("parses an engine-level error with no file/line attribution", () => {
    const log = "error: !File ended while scanning use of \\textbf \nerror: halted on potentially-recoverable error as specified";
    expect(parseCompileErrors(log)).toEqual([{ file: null, line: null, message: "!File ended while scanning use of \\textbf" }]);
  });

  it("drops the boilerplate 'halted on...' trailer line", () => {
    const log = "error: bad.tex:3: Missing $ inserted\nerror: halted on potentially-recoverable error as specified";
    const entries = parseCompileErrors(log);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("Missing $ inserted");
  });

  it("handles filenames containing spaces (already-valid upload paths)", () => {
    const log = "error: My Report (draft).tex:9: Undefined control sequence";
    expect(parseCompileErrors(log)).toEqual([{ file: "My Report (draft).tex", line: 9, message: "Undefined control sequence" }]);
  });

  it("extracts multiple distinct errors from one log", () => {
    const log = [
      "error: bad.tex:3: Undefined control sequence",
      "error: bad.tex:7: Missing $ inserted",
      "error: halted on potentially-recoverable error as specified",
    ].join("\n");
    expect(parseCompileErrors(log)).toEqual([
      { file: "bad.tex", line: 3, message: "Undefined control sequence" },
      { file: "bad.tex", line: 7, message: "Missing $ inserted" },
    ]);
  });

  it("returns an empty array for a log with no error: lines", () => {
    expect(parseCompileErrors("note: Running TeX ...\nnote: all good")).toEqual([]);
  });

  it("ignores 'Fontconfig error:' since it doesn't start the line with 'error:'", () => {
    const log = "Fontconfig error: Cannot load default config file: No such file: (null)";
    expect(parseCompileErrors(log)).toEqual([]);
  });
});
