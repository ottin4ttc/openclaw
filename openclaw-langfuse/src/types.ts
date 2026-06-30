// ---------------------------------------------------------------------------
// Local hook event/context type definitions (subset of what we use).
// These mirror the canonical types in src/plugins/types.ts but are defined
// locally because they are not re-exported from openclaw/plugin-sdk.
// ---------------------------------------------------------------------------

export type AgentCtx = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

export type ToolCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
};

export type SessionCtx = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
};

export type BeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

export type BeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
};

export type BeforeAgentStartEvent = {
  prompt: string;
  messages?: unknown[];
};

export type BeforeAgentStartResult = BeforePromptBuildResult & {
  modelOverride?: string;
  providerOverride?: string;
};

export type LlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

export type LlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

export type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

export type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

export type SessionEndEvent = {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
};

export type SessionEntry = { timestamp: number; message: Record<string, unknown> };

export type IncompleteTraceInfo = {
  traceId: string;
  agentId: string;
  sessionId: string;
  jsonlPath: string;
};

/**
 * Minimal logger interface compatible with openclaw/plugin-sdk PluginLogger.
 * Used by session/recovery modules that should not depend on openclaw/plugin-sdk directly.
 */
export type MinimalLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};
