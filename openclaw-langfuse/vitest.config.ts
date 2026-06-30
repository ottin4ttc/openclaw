import path from "node:path";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "openclaw/plugin-sdk/plugin-entry",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "plugin-entry.ts"),
      },
      {
        find: "openclaw/plugin-sdk/diagnostics-otel",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "diagnostics-otel.ts"),
      },
      {
        find: "openclaw/plugin-sdk",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
