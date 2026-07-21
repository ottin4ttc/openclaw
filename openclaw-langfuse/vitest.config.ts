import path from "node:path";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "openclaw/plugin-sdk/session-transcript-runtime",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "session-transcript-runtime.ts"),
      },
      {
        find: "openclaw/plugin-sdk/plugin-entry",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "plugin-entry.ts"),
      },
      {
        find: "openclaw/plugin-sdk/diagnostic-runtime",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "diagnostic-runtime.ts"),
      },
      {
        find: /^openclaw\/plugin-sdk\/(.+)$/,
        replacement: path.join(repoRoot, "src", "plugin-sdk", "$1.ts"),
      },
      {
        find: /^openclaw\/plugin-sdk$/,
        replacement: path.join(repoRoot, "src", "plugin-sdk", "index.ts"),
      },
      {
        find: /^@openclaw\/(?!(?:crabline|fs-safe|libterminal|proxyline|uirouter)(?:\/|$))([^/]+)\/(.+)$/,
        replacement: path.join(repoRoot, "packages", "$1", "src", "$2.ts"),
      },
      {
        find: /^@openclaw\/(?!(?:crabline|fs-safe|libterminal|proxyline|uirouter)$)([^/]+)$/,
        replacement: path.join(repoRoot, "packages", "$1", "src", "index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
