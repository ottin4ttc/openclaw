import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { readLastCacheTtlTimestamp } from "../../pi-embedded-runner/cache-ttl.js";
import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime, getOrInitCurrentTurn } from "./runtime.js";

const log = createSubsystemLogger("context-pruning");

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }
    if (runtime.settings.mode !== "cache-ttl") {
      return undefined;
    }

    // Turn boundary is detected via the session's last cache-ttl timestamp.
    // This value is stable within a turn (written once at turn end by
    // appendCacheTtlTimestamp) and changes when a new turn begins. We use it
    // as `turnKey` to anchor the current turn's start time.
    const turnKey = readLastCacheTtlTimestamp(ctx.sessionManager) ?? 0;
    const anchor = getOrInitCurrentTurn(ctx.sessionManager, turnKey, Date.now());
    if (!anchor) {
      return undefined;
    }

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
      referenceTime: anchor.turnStartTime,
    });

    if (next === event.messages) {
      return undefined;
    }

    log.info(
      `applied: mode=${runtime.settings.mode} msgs ${event.messages.length}->${next.length}`,
    );

    return { messages: next };
  });
}
