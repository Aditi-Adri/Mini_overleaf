import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { config } from "./config.js";
import { extractZip, pickMainFile } from "./zipImport.js";

function buildZip(entries: Array<{ path: string; content: string | Buffer }>): Buffer {
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.path, Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8"));
  }
  return zip.toBuffer();
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("extractZip", () => {
  it("extracts a flat project, classifying text vs binary by extension", () => {
    const zip = buildZip([
      { path: "main.tex", content: "\\documentclass{article}" },
      { path: "references.bib", content: "@book{x, title={y}}" },
      { path: "images/photo.png", content: PNG_BYTES },
    ]);

    const { files, skipped } = extractZip(zip);
    expect(skipped).toEqual([]);
    expect(files).toHaveLength(3);

    const main = files.find((f) => f.path === "main.tex")!;
    expect(main.kind).toBe("text");
    expect(main.content.toString("utf8")).toBe("\\documentclass{article}");

    const image = files.find((f) => f.path === "images/photo.png")!;
    expect(image.kind).toBe("binary");
    expect(image.contentType).toBe("image/png");
    expect(image.content.equals(PNG_BYTES)).toBe(true);
  });

  it("strips a single shared top-level wrapper folder", () => {
    const zip = buildZip([
      { path: "MyProject/main.tex", content: "\\documentclass{article}" },
      { path: "MyProject/sections/intro.tex", content: "intro" },
    ]);
    const { files } = extractZip(zip);
    expect(files.map((f) => f.path).sort()).toEqual(["main.tex", "sections/intro.tex"]);
  });

  it("does not strip when entries don't share a common top-level folder", () => {
    const zip = buildZip([
      { path: "main.tex", content: "\\documentclass{article}" },
      { path: "extra/notes.tex", content: "notes" },
    ]);
    const { files } = extractZip(zip);
    expect(files.map((f) => f.path).sort()).toEqual(["extra/notes.tex", "main.tex"]);
  });

  it("skips directory entries", () => {
    const zip = new AdmZip();
    zip.addFile("images/", Buffer.alloc(0));
    zip.addFile("main.tex", Buffer.from("\\documentclass{article}"));
    const { files } = extractZip(zip.toBuffer());
    expect(files.map((f) => f.path)).toEqual(["main.tex"]);
  });

  it("skips path-traversal / unsafe entries instead of crashing, and lists them", () => {
    // adm-zip's own addFile() already normalizes ".." out of a path at
    // write time, so a fixture built through addFile can never produce a
    // raw traversal entryName. Set it directly afterward to simulate a
    // zip built by some other (adversarial) tool that doesn't sanitize.
    const zip = new AdmZip();
    zip.addFile("main.tex", Buffer.from("\\documentclass{article}"));
    const evilEntry = zip.addFile("placeholder.tex", Buffer.from("evil"));
    evilEntry.entryName = "../../etc/passwd";

    const { files, skipped } = extractZip(zip.toBuffer());
    expect(files.map((f) => f.path)).toEqual(["main.tex"]);
    expect(skipped).toContain("../../etc/passwd");
  });

  it("still strips the shared wrapper folder even when one unrelated entry is rejected", () => {
    // A single invalid top-level entry must not defeat prefix-stripping for
    // every legitimate file alongside it (regression: the invalid entry's
    // path used to be included when deciding the "common" prefix).
    const zip = new AdmZip();
    zip.addFile("MyThesis/main.tex", Buffer.from("\\documentclass{article}"));
    zip.addFile("MyThesis/sections/intro.tex", Buffer.from("intro"));
    const evilEntry = zip.addFile("placeholder.tex", Buffer.from("evil"));
    evilEntry.entryName = "../../evil.tex";

    const { files, skipped } = extractZip(zip.toBuffer());
    expect(files.map((f) => f.path).sort()).toEqual(["main.tex", "sections/intro.tex"]);
    expect(skipped).toContain("../../evil.tex");
  });

  it("rejects an empty zip", () => {
    expect(() => extractZip(new AdmZip().toBuffer())).toThrow(/empty/i);
  });

  it("rejects a non-zip buffer", () => {
    expect(() => extractZip(Buffer.from("not a zip"))).toThrow(/not a valid zip/i);
  });

  it("rejects a zip with too many entries", () => {
    const original = config.maxZipEntryCount;
    config.maxZipEntryCount = 2;
    try {
      const zip = buildZip([
        { path: "a.tex", content: "a" },
        { path: "b.tex", content: "b" },
        { path: "c.tex", content: "c" },
      ]);
      expect(() => extractZip(zip)).toThrow(/too many files/i);
    } finally {
      config.maxZipEntryCount = original;
    }
  });

  it("rejects a zip whose uncompressed contents exceed the cap, without decompressing first", () => {
    const original = config.maxZipUncompressedBytes;
    config.maxZipUncompressedBytes = 10;
    try {
      const zip = buildZip([{ path: "big.tex", content: "x".repeat(1000) }]);
      expect(() => extractZip(zip)).toThrow(/too large/i);
    } finally {
      config.maxZipUncompressedBytes = original;
    }
  });
});

describe("pickMainFile", () => {
  it("prefers a root-level main.tex", () => {
    const zip = buildZip([
      { path: "main.tex", content: "" },
      { path: "sections/intro.tex", content: "" },
    ]);
    const { files } = extractZip(zip);
    expect(pickMainFile(files)).toBe("main.tex");
  });

  it("falls back to any root-level .tex file", () => {
    const zip = buildZip([
      { path: "report.tex", content: "" },
      { path: "sections/intro.tex", content: "" },
    ]);
    const { files } = extractZip(zip);
    expect(pickMainFile(files)).toBe("report.tex");
  });

  it("falls back to the alphabetically-first .tex file when nothing is at the root", () => {
    // Two *different* top-level folders, so common-prefix stripping (tested
    // separately above) doesn't kick in and collapse this into a root file.
    const zip = buildZip([
      { path: "chapters/two.tex", content: "" },
      { path: "appendix/one.tex", content: "" },
    ]);
    const { files } = extractZip(zip);
    expect(pickMainFile(files)).toBe("appendix/one.tex");
  });

  it("returns null when there are no .tex files at all", () => {
    const zip = buildZip([{ path: "references.bib", content: "" }]);
    const { files } = extractZip(zip);
    expect(pickMainFile(files)).toBeNull();
  });
});
