import { describe, expect, it } from "vitest";
import { isValidSessionId, workspaceDirFor } from "./session.js";

describe("isValidSessionId", () => {
  it("accepts a well-formed UUID", () => {
    expect(isValidSessionId("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidSessionId("../../etc/passwd")).toBe(false);
  });

  it("rejects non-string and empty input", () => {
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });
});

describe("workspaceDirFor", () => {
  it("stays inside the workspaces root for a valid id", () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(workspaceDirFor(id).endsWith(id)).toBe(true);
  });
});
