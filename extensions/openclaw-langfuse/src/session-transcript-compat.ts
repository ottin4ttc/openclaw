import fs from "node:fs";
import path from "node:path";
import * as sessionStoreRuntime from "openclaw/plugin-sdk/session-store-runtime";
import * as sessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import type { SessionTranscriptTargetParams } from "openclaw/plugin-sdk/session-transcript-runtime";

/**
 * Shape used by the newer visible-transcript projection.  7.1 does not expose
 * this helper, so the adapter projects its JSONL rows into the same shape.
 */
export type VisibleTranscriptMessageEntry = {
  entryId: string;
  parentId?: string | null;
  seq?: number;
  createdAt: string | number;
  message: unknown;
};

type VisibleReader = (
  params: SessionTranscriptTargetParams,
) => Promise<VisibleTranscriptMessageEntry[]> | VisibleTranscriptMessageEntry[];
type LegacyEventReader = (params: SessionTranscriptTargetParams) => Promise<unknown[]> | unknown[];

type LegacyTarget = { sessionFile: string };
type LegacyTargetResolver = (params: SessionTranscriptTargetParams) => Promise<LegacyTarget>;
type SessionKeyResolver = (params: {
  agentId: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}) => string | undefined;

function optionalExport<T>(module: object, name: string): T | undefined {
  const value = (module as Record<string, unknown>)[name];
  return typeof value === "function" ? (value as T) : undefined;
}

/** Resolves a 7.1 session key from the file-backed sessions.json registry. */
export function resolveTranscriptSessionKeyBySessionId(params: {
  agentId: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const publicResolver = optionalExport<SessionKeyResolver>(
    sessionStoreRuntime,
    "resolveTranscriptSessionKeyBySessionId",
  );
  if (publicResolver) {
    return publicResolver(params);
  }

  const loadSessionStore = optionalExport<
    (storePath: string, options?: Record<string, unknown>) => Record<string, { sessionId?: string }>
  >(sessionStoreRuntime, "loadSessionStore");
  const resolveStorePath = optionalExport<
    (store: string | undefined, options: { agentId: string; env?: NodeJS.ProcessEnv }) => string
  >(sessionStoreRuntime, "resolveStorePath");
  if (!loadSessionStore || !resolveStorePath) {
    return undefined;
  }
  const storePath = resolveStorePath(undefined, { agentId: params.agentId, env: params.env });
  const store = loadSessionStore(storePath, { hydrateSkillPromptRefs: false, skipCache: true });
  return Object.entries(store).find(([, entry]) => entry?.sessionId === params.sessionId)?.[0];
}

function projectLegacyVisibleEntries(events: unknown[]): VisibleTranscriptMessageEntry[] {
  const entries: VisibleTranscriptMessageEntry[] = [];
  let seq = 0;
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const parsed = event as Record<string, unknown>;
    if (!parsed.message || typeof parsed.message !== "object") {
      continue;
    }
    seq += 1;
    const entryId = typeof parsed.id === "string" ? parsed.id : `entry-${seq}`;
    const createdAt =
      typeof parsed.timestamp === "string" || typeof parsed.timestamp === "number"
        ? parsed.timestamp
        : new Date().toISOString();
    entries.push({
      entryId,
      ...(typeof parsed.parentId === "string" ? { parentId: parsed.parentId } : {}),
      seq,
      createdAt,
      message: parsed.message,
    });
  }
  return entries;
}

function readLegacyVisibleEntries(sessionFile: string): VisibleTranscriptMessageEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }
  const events: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
  }
  return projectLegacyVisibleEntries(events);
}

/**
 * Reads visible transcript rows through the newer optional SDK helper when it
 * exists, and otherwise resolves the 7.1 JSONL target locally.
 */
export async function readVisibleSessionTranscriptMessageEntries(
  params: SessionTranscriptTargetParams,
): Promise<VisibleTranscriptMessageEntry[]> {
  const publicReader = optionalExport<VisibleReader>(
    sessionTranscriptRuntime,
    "readVisibleSessionTranscriptMessageEntries",
  );
  if (publicReader) {
    return await publicReader(params);
  }
  const readLegacyEvents = optionalExport<LegacyEventReader>(
    sessionTranscriptRuntime,
    "readSessionTranscriptEvents",
  );
  if (readLegacyEvents) {
    // The 7.1 read facade resolves JSONL without persisting legacy file metadata.
    return projectLegacyVisibleEntries(await readLegacyEvents(params));
  }
  const resolveLegacyTarget = optionalExport<LegacyTargetResolver>(
    sessionTranscriptRuntime,
    "resolveSessionTranscriptLegacyFileTarget",
  );
  if (resolveLegacyTarget) {
    const target = await resolveLegacyTarget(params);
    return readLegacyVisibleEntries(target.sessionFile);
  }

  // This final path is only a defensive 7.1 fallback for a reduced SDK mock;
  // real hosts provide the public legacy target resolver above.
  const stateDir = params.env?.OPENCLAW_STATE_DIR ?? process.env.OPENCLAW_STATE_DIR;
  if (!stateDir || !params.agentId) {
    return [];
  }
  return readLegacyVisibleEntries(
    path.join(stateDir, "agents", params.agentId, "sessions", `${params.sessionId}.jsonl`),
  );
}
