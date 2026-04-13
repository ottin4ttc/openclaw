import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { readLastCacheTtlTimestamp } from "../../pi-embedded-runner/cache-ttl.js";
import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

const log = createSubsystemLogger("context-pruning");

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      // Always read the persisted timestamp from session history rather than
      // the in-memory cache.  appendCacheTtlTimestamp() (attempt.ts) writes
      // this once at turn end, so every LLM call within the same turn reads
      // the same value and makes a consistent TTL decision.
      const lastTouch = readLastCacheTtlTimestamp(ctx.sessionManager) ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
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
