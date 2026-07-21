import { describe, expect, it } from "vitest";
import { formatExecServerPathUri, resolveExecServerPath } from "./path-uri.js";

describe("exec-server PathUri formatting", () => {
  it("round-trips literal percent characters in POSIX sandbox paths", () => {
    const sandboxPath = "/workspace/100%/a?b#c%d.txt";

    const pathUri = formatExecServerPathUri(sandboxPath);

    expect(pathUri).toBe("file:///workspace/100%25/a%3Fb%23c%25d.txt");
    expect(resolveExecServerPath(pathUri, "sandbox path")).toBe(sandboxPath);
  });

  it("rejects relative paths before converting with host filesystem rules", () => {
    expect(() => formatExecServerPathUri("workspace")).toThrow(
      "sandbox path must be an absolute POSIX path.",
    );
  });
});
