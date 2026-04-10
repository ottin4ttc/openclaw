import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
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
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      const withinTtl = ttlMs > 0 && Date.now() - lastTouch < ttlMs;
      if (withinTtl) {
        // Within TTL window: still prune if new messages arrived since last pruning
        // (e.g. tool results added between LLM calls in the same turn).
        const lastCount = runtime.lastPrunedMessageCount ?? 0;
        if (lastCount > 0 && event.messages.length <= lastCount) {
          return undefined;
        }
        // Fall through to prune with new messages
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

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
      runtime.lastPrunedMessageCount = next.length;
    }

    return { messages: next };
  });
}
