/** Extracts native Codex subagent completions from trusted agent messages. */
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

const FINAL_ANSWER_HEADER = "Message Type: FINAL_ANSWER";
const TASK_NAME_PREFIX = "Task name: ";
const SENDER_PREFIX = "Sender: ";
const PAYLOAD_HEADER = "Payload:";
const ERROR_PREFIX = "Agent errored: ";
const ERROR_NEXT_ACTION =
  "This agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.";
const SHUTDOWN_PAYLOAD = "Agent shut down.";
const NOT_FOUND_PAYLOAD = "Agent was not found.";

/** Terminal status values OpenClaw accepts for Codex native subagent completion. */
export type CodexNativeSubagentCompletionStatus = "succeeded" | "failed" | "cancelled";

type CodexNativeSubagentCompletionDetails = {
  status: CodexNativeSubagentCompletionStatus;
  statusLabel: string;
  result: string;
};

/** Completion associated with a resolved child thread id. */
export type CodexNativeSubagentCompletion = CodexNativeSubagentCompletionDetails & {
  childThreadId: string;
};

/** Completion parsed from a notification payload before agent-path matching resolves the thread. */
export type CodexNativeSubagentNotificationCompletion = CodexNativeSubagentCompletionDetails & {
  agentPath: string;
};

/** Extracts trusted subagent completion payloads from a Codex server notification. */
export function extractCodexNativeSubagentCompletions(
  notification: CodexServerNotification,
): CodexNativeSubagentNotificationCompletion[] {
  if (notification.method !== "rawResponseItem/completed") {
    return [];
  }
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  const item = params && isJsonObject(params.item) ? params.item : undefined;
  if (!item || readString(item, "type") !== "agent_message") {
    return [];
  }
  const author = readString(item, "author")?.trim();
  const recipient = readString(item, "recipient")?.trim();
  const text = extractSingleInputTextPart(item);
  if (!author || !recipient || !text) {
    return [];
  }
  const envelope = parseFinalAnswerEnvelope(text);
  if (!envelope || envelope.sender !== author || envelope.taskName !== recipient) {
    return [];
  }
  return [{ agentPath: author, ...completionDetailsFromPayload(envelope.payload) }];
}

function parseFinalAnswerEnvelope(
  text: string,
): { taskName: string; sender: string; payload: string } | undefined {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  if (
    lines[0] !== FINAL_ANSWER_HEADER ||
    !lines[1]?.startsWith(TASK_NAME_PREFIX) ||
    !lines[2]?.startsWith(SENDER_PREFIX) ||
    lines[3] !== PAYLOAD_HEADER
  ) {
    return undefined;
  }
  const taskName = lines[1].slice(TASK_NAME_PREFIX.length).trim();
  const sender = lines[2].slice(SENDER_PREFIX.length).trim();
  if (!taskName || !sender) {
    return undefined;
  }
  return { taskName, sender, payload: lines.slice(4).join("\n").trim() };
}

function completionDetailsFromPayload(payload: string): CodexNativeSubagentCompletionDetails {
  if (payload === SHUTDOWN_PAYLOAD) {
    return { status: "cancelled", statusLabel: "shutdown", result: SHUTDOWN_PAYLOAD };
  }
  if (payload === NOT_FOUND_PAYLOAD) {
    return { status: "failed", statusLabel: "not_found", result: NOT_FOUND_PAYLOAD };
  }
  if (payload.startsWith(ERROR_PREFIX)) {
    const suffix = `\n\n${ERROR_NEXT_ACTION}`;
    const error = payload
      .slice(ERROR_PREFIX.length, payload.endsWith(suffix) ? -suffix.length : undefined)
      .trim();
    return { status: "failed", statusLabel: "errored", result: error || "(no output)" };
  }
  if (!payload) {
    return {
      status: "succeeded",
      statusLabel: "completed_without_final_message",
      result: "Codex native subagent completed without a final assistant message.",
    };
  }
  return { status: "succeeded", statusLabel: "completed", result: payload };
}

function extractSingleInputTextPart(item: JsonObject): string | undefined {
  const content = item.content;
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }
  const [entry] = content;
  if (!isJsonObject(entry) || readString(entry, "type") !== "input_text") {
    return undefined;
  }
  return readString(entry, "text")?.trim();
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
