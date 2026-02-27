import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { resolveSandboxContext } from "../sandbox.js";
import { parseSandboxBindMount } from "../sandbox/fs-paths.js";
import type { EmbeddedSandboxInfo } from "./types.js";

export function buildEmbeddedSandboxInfo(
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>,
  execElevated?: ExecElevatedDefaults,
): EmbeddedSandboxInfo | undefined {
  if (!sandbox?.enabled) {
    return undefined;
  }
  const elevatedAllowed = Boolean(execElevated?.enabled && execElevated.allowed);
  const customMounts = resolveCustomMountPaths(sandbox.docker.binds);
  return {
    enabled: true,
    workspaceDir: sandbox.workspaceDir,
    containerWorkspaceDir: sandbox.containerWorkdir,
    workspaceAccess: sandbox.workspaceAccess,
    agentWorkspaceMount: sandbox.workspaceAccess === "ro" ? "/agent" : undefined,
    browserBridgeUrl: sandbox.browser?.bridgeUrl,
    browserNoVncUrl: sandbox.browser?.noVncUrl,
    hostBrowserAllowed: sandbox.browserAllowHostControl,
    ...(customMounts.length > 0 ? { customMounts } : {}),
    ...(elevatedAllowed
      ? {
          elevated: {
            allowed: true,
            defaultLevel: execElevated?.defaultLevel ?? "off",
          },
        }
      : {}),
  };
}

function resolveCustomMountPaths(binds?: string[]): string[] {
  if (!binds?.length) {
    return [];
  }
  const paths: string[] = [];
  for (const spec of binds) {
    const parsed = parseSandboxBindMount(spec);
    if (parsed) {
      const mode = parsed.writable ? "rw" : "ro";
      paths.push(`${parsed.containerRoot} (${mode}, host: ${parsed.hostRoot})`);
    }
  }
  return paths;
}
