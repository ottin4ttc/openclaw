import { createSessionManagerRuntimeRegistry } from "../session-manager-runtime-registry.js";
import type { EffectiveContextPruningSettings } from "./settings.js";

export type CurrentTurnAnchor = {
  /** Stable identifier of the current turn (last cache-ttl timestamp, or 0 if none). */
  turnKey: number;
  /** Time recorded at the first `context` event of the current turn. */
  turnStartTime: number;
};

export type ContextPruningRuntimeValue = {
  settings: EffectiveContextPruningSettings;
  contextWindowTokens?: number | null;
  isToolPrunable: (toolName: string) => boolean;
  currentTurn?: CurrentTurnAnchor | null;
};

// Important: this relies on Pi passing the same SessionManager object instance into
// ExtensionContext (ctx.sessionManager) that we used when calling setContextPruningRuntime.
const registry = createSessionManagerRuntimeRegistry<ContextPruningRuntimeValue>();

export const setContextPruningRuntime = registry.set;

export const getContextPruningRuntime = registry.get;

/**
 * Return the anchor for the current turn. If no anchor exists or the stored
 * `turnKey` differs from the provided one, a new anchor is created and stored
 * with `turnStartTime = now`. Returns `null` only if no runtime is registered.
 */
export function getOrInitCurrentTurn(
  sessionManager: unknown,
  turnKey: number,
  now: number,
): CurrentTurnAnchor | null {
  const runtime = registry.get(sessionManager);
  if (!runtime) {
    return null;
  }
  const existing = runtime.currentTurn;
  if (existing && existing.turnKey === turnKey) {
    return existing;
  }
  const next: CurrentTurnAnchor = { turnKey, turnStartTime: now };
  runtime.currentTurn = next;
  return next;
}
