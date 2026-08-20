import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import path from "node:path";
import Langfuse from "langfuse";
import { waitForDiagnosticEventsDrained } from "openclaw/plugin-sdk/diagnostic-runtime";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { createHash } from "node:crypto";
import fs from "node:fs";
import * as sessionStoreRuntime from "openclaw/plugin-sdk/session-store-runtime";
import * as sessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { AsyncLocalStorage } from "node:async_hooks";
//#region extensions/openclaw-langfuse/src/config.ts
/**
* Resolve Langfuse credentials: env vars take precedence over plugin config.
* - LANGFUSE_PUBLIC_KEY / config.publicKey
* - LANGFUSE_SECRET_KEY / config.secretKey
* - LANGFUSE_BASE_URL / config.baseUrl (default: https://cloud.langfuse.com)
*/
function resolveCredentials(config) {
	return {
		publicKey: process.env["LANGFUSE_PUBLIC_KEY"] ?? config.publicKey,
		secretKey: process.env["LANGFUSE_SECRET_KEY"] ?? config.secretKey,
		baseUrl: process.env["LANGFUSE_BASE_URL"] ?? config.baseUrl ?? "https://cloud.langfuse.com"
	};
}
//#endregion
//#region extensions/openclaw-langfuse/src/redact.ts
const REDACTED_CONTENT = "[REDACTED]";
const FAILED_PROJECTION_CONTENT = "[unserializable: projection]";
const OMITTED_PROJECTION_FIELDS = /* @__PURE__ */ new Set(["encrypted_content", "thinkingSignature"]);
function stringifyLangfuseProjection(value) {
	const ancestors = [];
	return JSON.stringify(value, function(key, nested) {
		if (OMITTED_PROJECTION_FIELDS.has(key)) return;
		if (!nested || typeof nested !== "object") return nested;
		while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
		if (ancestors.includes(nested)) return "[unserializable: circular]";
		ancestors.push(nested);
		return nested;
	});
}
/**
* Remove provider continuation payloads that Langfuse cannot interpret.
* Keep the source object intact because the same reasoning item may still be
* required by the provider transport on the next call.
*/
function projectLangfusePayload(value) {
	try {
		const serialized = stringifyLangfuseProjection(value);
		if (serialized === void 0) return value && typeof value === "object" ? FAILED_PROJECTION_CONTENT : value;
		return JSON.parse(serialized);
	} catch {
		return FAILED_PROJECTION_CONTENT;
	}
}
/**
* Suppress text content completely when redaction is enabled.
* Returns the original text if redaction is disabled.
*/
function redactText(text, enabled = true) {
	if (!enabled || !text) return text;
	return REDACTED_CONTENT;
}
/**
* Suppress payload content completely, or apply the safe Langfuse projection
* when full redaction is disabled.
* Field names, scalar values, array lengths, and object shape can all reveal
* private prompt/tool content, so enabled redaction collapses present payloads
* to a single marker instead of preserving structure.
*/
function redactObject(obj, enabled = true) {
	if (!enabled) return projectLangfusePayload(obj);
	if (obj === void 0 || obj === null) return obj;
	if (typeof obj === "string") return redactText(obj, enabled);
	return REDACTED_CONTENT;
}
//#endregion
//#region extensions/openclaw-langfuse/src/utils.ts
const MAX_PAYLOAD_BYTES = 100 * 1024;
const PRIOR_CONVERSATION_PROJECTION = "value";
const LANGFUSE_SDK_EVENT_LIMIT_BYTES = 1e6;
/** Build qualified model name: provider/model (e.g. zenmux-anthropic/anthropic/claude-opus-4.6) */
function qualifiedModel(provider, model) {
	const m = String(model ?? "unknown");
	if (provider && !m.startsWith(provider + "/")) return `${provider}/${m}`;
	return m;
}
/**
* Generate a deterministic trace ID from session key and timestamp.
* Exported so external callers can compute the same ID.
*/
function generateTraceId(sessionKey, timestamp) {
	return createHash("sha256").update(`${sessionKey}:${timestamp}`).digest("hex").slice(0, 32);
}
function generateObservationId(traceId, type, indexOrToolCallId) {
	if (type === "gen") return `${traceId}-gen-${indexOrToolCallId}`;
	return `${traceId}-${type}-${indexOrToolCallId}`;
}
/**
* Return the timestamp embedded in the persisted message when available.
* For user/toolResult rows this is the event time. For assistant rows this is
* the model-call start time in current OpenClaw session JSONL.
*/
function messageTimestamp(entry) {
	const raw = entry.message.timestamp;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return entry.timestamp;
}
/**
* Assistant rows carry two useful times:
* - message.timestamp: model call start
* - outer row timestamp: assistant response persisted/completed
*/
function assistantStartTimestamp(entry) {
	return messageTimestamp(entry);
}
function assistantEndTimestamp(entry) {
	return entry.timestamp;
}
/**
* Truncate a payload to MAX_PAYLOAD_BYTES. Returns original object if small
* enough, otherwise a truncated string with a size notice.
*/
function truncatePayload(obj) {
	if (obj === void 0 || obj === null) return obj;
	let payload = projectLangfusePayload(obj);
	let serialized = safeJsonStringify(payload);
	if (serialized === void 0) try {
		payload = normalizeJsonPayload(payload, /* @__PURE__ */ new WeakSet());
		serialized = JSON.stringify(payload);
	} catch {
		payload = "[unserializable: payload]";
		serialized = JSON.stringify(payload);
	}
	if (!serialized) return payload;
	const byteLength = Buffer.byteLength(serialized, "utf-8");
	if (byteLength <= 102400) return payload;
	const notice = `\n[truncated: original size ${Math.round(byteLength / 1024)}kb]`;
	let lo = 0;
	let hi = serialized.length;
	while (lo < hi) {
		const mid = lo + hi + 1 >>> 1;
		const candidate = serialized.slice(0, mid) + notice;
		if (Buffer.byteLength(JSON.stringify(candidate), "utf-8") <= 102400) lo = mid;
		else hi = mid - 1;
	}
	if (lo > 0 && lo < serialized.length) {
		const previous = serialized.charCodeAt(lo - 1);
		const next = serialized.charCodeAt(lo);
		if (previous >= 55296 && previous <= 56319 && next >= 56320 && next <= 57343) lo -= 1;
	}
	return serialized.slice(0, lo) + notice;
}
function payloadFacts(value, redactEnabled) {
	const redacted = redactObject(value, redactEnabled);
	let serialized = safeJsonStringify(redacted);
	let serializableValue = redacted;
	if (serialized === void 0) {
		serializableValue = normalizeJsonPayload(redacted, /* @__PURE__ */ new WeakSet());
		serialized = JSON.stringify(serializableValue);
	}
	const originalBytes = Buffer.byteLength(serialized ?? "", "utf8");
	return {
		value: originalBytes > 102400 ? truncatePayload(serializableValue) : serializableValue,
		originalBytes,
		truncated: originalBytes > MAX_PAYLOAD_BYTES,
		sha256: createHash("sha256").update(serialized ?? "").digest("hex")
	};
}
function wholeMessageSuffixFacts(messages, redactEnabled) {
	const redacted = redactObject(messages.map(projectPriorConversationMessage).filter((message) => message !== void 0), redactEnabled);
	const normalized = Array.isArray(redacted) ? redacted : normalizeJsonPayload(redacted, /* @__PURE__ */ new WeakSet());
	const sourceMessages = Array.isArray(normalized) ? normalized : [];
	const serialized = JSON.stringify(sourceMessages);
	const originalBytes = Buffer.byteLength(serialized, "utf8");
	const sha256 = createHash("sha256").update(serialized).digest("hex");
	if (originalBytes <= 102400) return {
		value: sourceMessages,
		originalBytes,
		retainedCount: sourceMessages.length,
		sha256,
		truncated: false
	};
	const retained = [];
	for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
		const candidate = [sourceMessages[index], ...retained];
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 102400) break;
		retained.unshift(sourceMessages[index]);
	}
	return {
		value: retained,
		originalBytes,
		retainedCount: retained.length,
		sha256,
		truncated: true
	};
}
function projectPriorConversationMessage(message) {
	if (!message || typeof message !== "object" || Array.isArray(message)) return;
	const candidate = projectLangfusePayload(message);
	if (isReasoningOnlyAssistantMessage(candidate)) return;
	if (candidate.role === "user") return {
		role: "user",
		content: extractUserMessageText(candidate.content)
	};
	if (typeof candidate.role !== "string") return;
	return buildApiMessage(candidate);
}
/** Projects the canonical pre-inference hook boundary onto trace-level fields. */
function normalizeBeforeAgentRunTraceContext(params) {
	const rootInput = truncatePayload(redactText(params.prompt, params.redactEnabled));
	const metadata = {};
	if (params.systemPrompt !== void 0) {
		const systemPromptFacts = payloadFacts(params.systemPrompt, params.redactEnabled);
		Object.assign(metadata, {
			system_prompt: systemPromptFacts.value,
			system_prompt_bytes: systemPromptFacts.originalBytes,
			system_prompt_truncated: systemPromptFacts.truncated,
			system_prompt_sha256: systemPromptFacts.sha256
		});
	}
	if (params.priorMessages !== void 0) {
		const priorConversationFacts = wholeMessageSuffixFacts(params.priorMessages, params.redactEnabled);
		Object.assign(metadata, {
			prior_conversation: priorConversationFacts.value,
			prior_conversation_projection: PRIOR_CONVERSATION_PROJECTION,
			prior_conversation_bytes: priorConversationFacts.originalBytes,
			prior_conversation_truncated: priorConversationFacts.truncated,
			prior_conversation_sha256: priorConversationFacts.sha256,
			prior_conversation_message_count: params.priorMessages.length,
			prior_conversation_retained_message_count: priorConversationFacts.retainedCount
		});
		return {
			metadata,
			rootInput,
			priorConversation: priorConversationFacts.value
		};
	}
	return {
		metadata,
		rootInput
	};
}
function messageRole(message) {
	if (!message || typeof message !== "object" || Array.isArray(message)) return;
	const role = message.role;
	return typeof role === "string" ? role : void 0;
}
function commonMessagePrefixLength(previousMessages, messages) {
	const count = Math.min(previousMessages.length, messages.length);
	let index = 0;
	for (; index < count; index++) {
		const previous = safeJsonStringify(previousMessages[index]);
		const current = safeJsonStringify(messages[index]);
		if (previous === void 0 || current === void 0 || previous !== current) break;
	}
	return index;
}
function hasCompleteMessagePrefix(previousMessages, messages) {
	return previousMessages.length <= messages.length && commonMessagePrefixLength(previousMessages, messages) === previousMessages.length;
}
function countToolDefinitions(tools) {
	if (Array.isArray(tools)) return tools.length;
	return tools === void 0 || tools === null ? 0 : 1;
}
const MAX_GENERATION_MESSAGE_FIELD_BYTES = 2 * 1024;
const MAX_GENERATION_MESSAGE_KEYS = 24;
const MAX_GENERATION_TOOL_CALLS = 32;
function boundedGenerationMessageField(value, redactEnabled) {
	const redacted = redactObject(value, redactEnabled);
	let serialized = safeJsonStringify(redacted);
	let serializableValue = redacted;
	if (serialized === void 0) {
		serializableValue = normalizeJsonPayload(redacted, /* @__PURE__ */ new WeakSet());
		serialized = JSON.stringify(serializableValue);
	}
	const originalBytes = Buffer.byteLength(serialized ?? "", "utf8");
	if (originalBytes <= MAX_GENERATION_MESSAGE_FIELD_BYTES) return serializableValue;
	return {
		truncated: true,
		original_bytes: originalBytes,
		sha256: createHash("sha256").update(serialized ?? "").digest("hex")
	};
}
function compactGenerationToolCall(value, redactEnabled) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return boundedGenerationMessageField(value, redactEnabled);
	const call = value;
	const fn = call.function && typeof call.function === "object" && !Array.isArray(call.function) ? call.function : void 0;
	return {
		...call.id !== void 0 ? { id: boundedGenerationMessageField(call.id, redactEnabled) } : {},
		...call.type !== void 0 ? { type: boundedGenerationMessageField(call.type, redactEnabled) } : {},
		...call.name !== void 0 ? { name: boundedGenerationMessageField(call.name, redactEnabled) } : {},
		...fn ? { function: {
			...fn.name !== void 0 ? { name: boundedGenerationMessageField(fn.name, redactEnabled) } : {},
			...fn.arguments !== void 0 ? { arguments: boundedGenerationMessageField(fn.arguments, redactEnabled) } : {}
		} } : {}
	};
}
function compactGenerationMessage(value, redactEnabled) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { value: boundedGenerationMessageField(value, redactEnabled) };
	const entries = Object.entries(value);
	const compact = {};
	for (const [key, fieldValue] of entries.slice(0, MAX_GENERATION_MESSAGE_KEYS)) {
		if (key === "tool_calls" && Array.isArray(fieldValue)) {
			compact.tool_calls = fieldValue.slice(0, MAX_GENERATION_TOOL_CALLS).map((call) => compactGenerationToolCall(call, redactEnabled));
			if (fieldValue.length > MAX_GENERATION_TOOL_CALLS) compact.tool_calls_truncated = {
				original_count: fieldValue.length,
				retained_count: MAX_GENERATION_TOOL_CALLS
			};
			continue;
		}
		compact[key] = boundedGenerationMessageField(fieldValue, redactEnabled);
	}
	if (entries.length > MAX_GENERATION_MESSAGE_KEYS) compact.fields_truncated = {
		original_count: entries.length,
		retained_count: MAX_GENERATION_MESSAGE_KEYS
	};
	return compact;
}
function buildBoundedGenerationInput(params) {
	const redactedMessages = redactObject(params.messages, params.redactEnabled);
	const redactedTools = params.tools === void 0 ? void 0 : redactObject(params.tools, params.redactEnabled);
	const input = {
		...params.model ? { model: params.model } : {},
		messages: redactedMessages,
		...redactedTools !== void 0 ? { tools: redactedTools } : {}
	};
	const serialized = safeJsonStringify(input);
	if (serialized && Buffer.byteLength(serialized, "utf8") <= 102400) return input;
	if (redactedTools !== void 0) {
		const toolsFacts = payloadFacts(params.tools, params.redactEnabled);
		const withoutToolDefinitions = {
			...params.model ? { model: params.model } : {},
			messages: redactedMessages,
			tools: {
				truncated: true,
				original_bytes: toolsFacts.originalBytes,
				sha256: toolsFacts.sha256,
				tool_count: countToolDefinitions(params.tools)
			}
		};
		const withoutToolsSerialized = safeJsonStringify(withoutToolDefinitions);
		if (withoutToolsSerialized && Buffer.byteLength(withoutToolsSerialized, "utf8") <= 102400) return withoutToolDefinitions;
	}
	const messagesFacts = payloadFacts(params.messages, params.redactEnabled);
	const toolsFacts = redactedTools !== void 0 ? payloadFacts(params.tools, params.redactEnabled) : void 0;
	const compactMessages = params.messages.map((message) => compactGenerationMessage(message, params.redactEnabled));
	const messagesTruncation = {
		truncated: true,
		original_bytes: messagesFacts.originalBytes,
		sha256: messagesFacts.sha256,
		original_count: params.messages.length,
		retained_count: compactMessages.length
	};
	const compactInput = {
		...params.model ? { model: boundedGenerationMessageField(params.model, params.redactEnabled) } : {},
		messages: compactMessages,
		messages_truncation: messagesTruncation,
		...toolsFacts ? { tools: {
			truncated: true,
			original_bytes: toolsFacts.originalBytes,
			sha256: toolsFacts.sha256,
			tool_count: countToolDefinitions(params.tools)
		} } : {}
	};
	const compactSerialized = safeJsonStringify(compactInput);
	if (compactSerialized && Buffer.byteLength(compactSerialized, "utf8") <= 102400) return compactInput;
	const retainedMessages = [];
	for (let index = compactMessages.length - 1; index >= 0; index -= 1) {
		const candidateMessages = [compactMessages[index], ...retainedMessages];
		const candidateSerialized = safeJsonStringify({
			...compactInput,
			messages: candidateMessages,
			messages_truncation: {
				...messagesTruncation,
				retained_count: candidateMessages.length
			}
		});
		if (candidateSerialized && Buffer.byteLength(candidateSerialized, "utf8") <= 102400) {
			retainedMessages.unshift(compactMessages[index]);
			continue;
		}
		break;
	}
	while (messageRole(retainedMessages[0]) === "tool") retainedMessages.shift();
	return {
		...compactInput,
		messages: retainedMessages,
		messages_truncation: {
			...messagesTruncation,
			retained_count: retainedMessages.length
		}
	};
}
/**
* Normalize one provider request into trace-scoped stable context plus a
* generation-scoped message delta. Callers keep nextMessages for the next
* request in the same turn.
*/
function normalizeModelCallInput(params) {
	const messages = Array.isArray(params.messages) ? params.messages : [];
	const firstCall = params.previousMessages === void 0;
	const prefixProven = !firstCall && hasCompleteMessagePrefix(params.previousMessages ?? [], messages);
	const deltaMessages = firstCall ? messages : prefixProven ? messages.slice(params.previousMessages?.length ?? 0) : [];
	const traceMetadata = {};
	let priorConversation;
	if (firstCall && params.systemPrompt !== void 0) {
		const systemPromptFacts = payloadFacts(params.systemPrompt, params.redactEnabled);
		Object.assign(traceMetadata, {
			system_prompt: systemPromptFacts.value,
			system_prompt_bytes: systemPromptFacts.originalBytes,
			system_prompt_truncated: systemPromptFacts.truncated,
			system_prompt_sha256: systemPromptFacts.sha256
		});
	}
	if (firstCall && params.priorMessages !== void 0) {
		const priorConversationFacts = wholeMessageSuffixFacts(params.priorMessages, params.redactEnabled);
		priorConversation = priorConversationFacts.value;
		Object.assign(traceMetadata, {
			prior_conversation: priorConversationFacts.value,
			prior_conversation_projection: PRIOR_CONVERSATION_PROJECTION,
			prior_conversation_bytes: priorConversationFacts.originalBytes,
			prior_conversation_truncated: priorConversationFacts.truncated,
			prior_conversation_sha256: priorConversationFacts.sha256,
			prior_conversation_message_count: params.priorMessages.length,
			prior_conversation_retained_message_count: priorConversationFacts.retainedCount
		});
	}
	const generationInput = firstCall && params.firstGenerationInput !== void 0 ? buildBoundedGenerationInput({
		model: params.model,
		messages: [{
			role: "user",
			content: params.firstGenerationInput
		}],
		redactEnabled: params.redactEnabled
	}) : firstCall || prefixProven ? buildBoundedGenerationInput({
		model: params.model,
		messages: deltaMessages,
		tools: params.tools,
		redactEnabled: params.redactEnabled
	}) : void 0;
	return {
		...generationInput !== void 0 ? { generationInput } : {},
		traceMetadata,
		nextMessages: [...messages],
		projection: firstCall && params.firstGenerationInput !== void 0 ? "first-prompt" : firstCall ? "full-request" : prefixProven ? "proven-prefix" : "unavailable",
		...priorConversation !== void 0 ? { priorConversation } : {}
	};
}
function safeJsonStringify(obj) {
	try {
		return JSON.stringify(obj);
	} catch {
		return;
	}
}
function normalizeJsonPayload(value, seen) {
	if (typeof value === "bigint") return "[unserializable: bigint]";
	if (typeof value === "function") return "[unserializable: function]";
	if (typeof value === "symbol") return "[unserializable: symbol]";
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[unserializable: circular]";
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : String(value);
	seen.add(value);
	if (Array.isArray(value)) {
		const normalized = value.map((item) => normalizeJsonPayload(item, seen));
		seen.delete(value);
		return normalized;
	}
	const normalized = {};
	for (const key of Object.keys(value)) try {
		normalized[key] = normalizeJsonPayload(value[key], seen);
	} catch {
		normalized[key] = "[unserializable: property]";
	}
	seen.delete(value);
	return normalized;
}
/**
* Check if a content block is a tool call (OpenClaw `toolCall` or Anthropic API `tool_use`).
*/
function isToolCallBlock(block) {
	if (!block || typeof block !== "object") return false;
	const b = block;
	return b.type === "toolCall" || b.type === "tool_use";
}
/**
* Codex app-server mirrors reasoning items as assistant transcript rows with
* a stable `${turnId}:reasoning` identity. User-visible assistant text can
* legitimately start with "Codex reasoning:", so text alone is not a marker.
*/
function isReasoningOnlyAssistantMessage(msg) {
	if (msg.role !== "assistant") return false;
	const mirrorIdentity = msg.__openclaw?.mirrorIdentity;
	if (typeof mirrorIdentity === "string" && mirrorIdentity.endsWith(":reasoning")) return true;
	return false;
}
/**
* Codex app-server mirrors native tool calls as assistant transcript rows so
* OpenClaw history can show tool progress. They are not separate model calls;
* the turn-level token usage is attached to the final `${turnId}:assistant`.
*/
function isCodexToolCallMirrorMessage(msg) {
	if (msg.role !== "assistant") return false;
	const mirrorIdentity = msg.__openclaw?.mirrorIdentity;
	if (typeof mirrorIdentity !== "string" || !mirrorIdentity.includes(":tool:") || !mirrorIdentity.endsWith(":call")) return false;
	if (!Array.isArray(msg.content) || !msg.content.some((block) => isToolCallBlock(block))) return false;
	return !hasNonZeroUsage(msg.usage);
}
function isTranscriptOnlyAssistantMessage(msg) {
	return isReasoningOnlyAssistantMessage(msg) || isCodexToolCallMirrorMessage(msg);
}
function isTraceableAssistantEntry(entry) {
	return entry.message.role === "assistant" && !isTranscriptOnlyAssistantMessage(entry.message);
}
function isTraceContextInputEntry(entry) {
	return !isTranscriptOnlyAssistantMessage(entry.message);
}
const MAX_TEXT_CONTENT_DEPTH = 32;
/**
* Extract text content from a message content field.
* Handles both plain string content and content-block arrays.
*/
function extractTextContent(content) {
	return extractTextContentInner(content, 0, /* @__PURE__ */ new WeakSet());
}
function extractTextContentInner(content, depth, seen) {
	if (depth > MAX_TEXT_CONTENT_DEPTH) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		if (seen.has(content)) return "";
		seen.add(content);
		const extracted = content.map((block) => extractTextContentInner(block, depth + 1, seen)).filter(Boolean).join("\n");
		seen.delete(content);
		return extracted;
	}
	if (content && typeof content === "object") {
		if (seen.has(content)) return "";
		seen.add(content);
		const block = content;
		if (typeof block.text === "string") {
			seen.delete(content);
			return block.text;
		}
		if ("content" in block) {
			const extracted = extractTextContentInner(block.content, depth + 1, seen);
			seen.delete(content);
			return extracted;
		}
		seen.delete(content);
	}
	return "";
}
/**
* Extract the full conversation as structured input and the last assistant response as output.
* Input includes all messages as a structured array for full context visibility.
* Output is the last assistant text response.
*/
function extractConversation(messages) {
	let lastAssistantText = "";
	let lastUserText = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && !lastAssistantText) lastAssistantText = extractTextContent(msg.content);
		if (msg.role === "user" && !lastUserText) {
			lastUserText = extractTextContent(msg.content);
			break;
		}
	}
	return {
		input: messages.map((message) => buildApiMessage(message)),
		output: lastAssistantText,
		lastUserText
	};
}
/**
* Build an API-shaped message object from a session entry message.
* Preserves structure: assistant with tool calls, toolResult -> tool role, etc.
* Matches the actual LLM API request format (see langfuse_api_reference.md).
*/
function buildApiMessage(msg) {
	const role = msg.role;
	if (role === "assistant") {
		const textContent = extractTextContent(msg.content);
		if (Array.isArray(msg.content)) {
			const toolCalls = msg.content.filter((b) => isToolCallBlock(b)).map((b) => ({
				id: b.id,
				type: "function",
				function: {
					name: b.name,
					arguments: JSON.stringify(b.input ?? b.args ?? b.arguments ?? {})
				}
			}));
			if (toolCalls.length > 0) return {
				role: "assistant",
				content: textContent || null,
				tool_calls: toolCalls
			};
		}
		return {
			role: "assistant",
			content: textContent
		};
	}
	if (role === "toolResult" || role === "tool") return {
		role: "tool",
		tool_call_id: msg.toolCallId ?? msg.tool_call_id ?? msg.toolName ?? "unknown",
		content: extractTextContent(msg.content)
	};
	return {
		role,
		content: extractTextContent(msg.content)
	};
}
/**
* Extract individual LLM turns from session messages.
* Each assistant message = one LLM call. Input is the preceding user/toolResult messages.
*/
function extractLLMTurns(messages) {
	const turns = [];
	let currentInput = [];
	for (const msg of messages) {
		const m = msg;
		if (m.role === "assistant") {
			const toolCalls = [];
			if (Array.isArray(m.content)) {
				for (const block of m.content) if (isToolCallBlock(block)) toolCalls.push({
					name: String(block.name ?? "unknown"),
					id: String(block.id ?? ""),
					input: block.input ?? block.args ?? block.arguments
				});
			}
			turns.push({
				inputMessages: [...currentInput],
				assistantMessage: m,
				assistantText: extractTextContent(m.content),
				toolCalls
			});
			currentInput = [];
		} else currentInput.push(msg);
	}
	return turns;
}
/**
* Filter session entries to only the current agent turn.
* A turn starts at the last user message; everything after it
* (assistant responses, toolResults) belongs to that turn.
*/
function filterCurrentTurnEntries(entries) {
	let lastUserIdx = 0;
	for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.message.role === "user") {
		lastUserIdx = i;
		break;
	}
	return entries.slice(lastUserIdx);
}
/**
* Legacy wrapper: filter plain message arrays (used by diagnostic handler).
*/
function filterCurrentTurnMessages(messages) {
	let lastUserIdx = 0;
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") {
		lastUserIdx = i;
		break;
	}
	return messages.slice(lastUserIdx);
}
/**
* Build structured generation output from assistant message content (D3 format).
* - Has tool calls + text: {text, toolCalls}
* - Pure text: direct string
* - Only tool calls: {toolCalls}
*/
function buildGenerationOutput(content, redactEnabled) {
	const text = extractTextContent(content);
	const toolCalls = [];
	if (Array.isArray(content)) {
		for (const block of content) if (isToolCallBlock(block)) toolCalls.push({
			id: block.id,
			type: "function",
			function: {
				name: String(block.name ?? "unknown"),
				arguments: JSON.stringify(redactObject(block.input ?? block.args ?? block.arguments ?? {}, redactEnabled))
			}
		});
	}
	const redactedText = text ? redactText(text, redactEnabled) : "";
	if (toolCalls.length > 0) return {
		content: redactedText || null,
		tool_calls: toolCalls
	};
	return redactedText || void 0;
}
/**
* Extract the plain user message text from a user message content field.
* Strips the "Sender (untrusted metadata):" wrapper to get the actual user input.
*/
function extractUserMessageText(content) {
	const text = extractTextContent(content);
	if (!text) return "";
	const senderStart = text.indexOf("Sender (untrusted metadata):");
	if (senderStart !== -1) {
		const fenceStart = text.indexOf("```json", senderStart + 28);
		const fenceEnd = fenceStart === -1 ? -1 : text.indexOf("```", fenceStart + 7);
		if (fenceEnd === -1) return text;
		const afterBlock = text.slice(fenceEnd + 3).trim();
		const tsMatch = afterBlock.match(/^\[[^\]]+\]\s*([\s\S]+)/);
		if (tsMatch?.[1]?.trim()) return tsMatch[1].trim();
		if (afterBlock) return afterBlock;
	}
	return text;
}
/**
* Check if a usage object has any non-zero values.
*/
function hasNonZeroUsage(usage) {
	if (!usage) return false;
	return Object.values(usage).some((v) => typeof v === "number" && v > 0);
}
function usageDetailsFromUsage(usage) {
	if (!usage || !Object.values(usage).some((value) => typeof value === "number" && Number.isFinite(value))) return;
	const total = usageTotalFromUsage(usage);
	return {
		...typeof usage.input === "number" ? { input: usage.input } : {},
		...typeof usage.output === "number" ? { output: usage.output } : {},
		...typeof total === "number" ? { total } : {},
		...typeof usage.cacheRead === "number" ? { cache_read_input_tokens: usage.cacheRead } : {},
		...typeof usage.cacheWrite === "number" ? { cache_creation_input_tokens: usage.cacheWrite } : {},
		...typeof usage.reasoningTokens === "number" ? { reasoning_tokens: usage.reasoningTokens } : {}
	};
}
function addUsageToTotals(totals, usage) {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.total += usageTotalFromUsage(usage) ?? 0;
}
function usageTotalFromUsage(usage) {
	const explicitTotal = usage.totalTokens ?? usage.total;
	if (typeof explicitTotal === "number") return explicitTotal;
	if (typeof usage.input === "number" || typeof usage.output === "number") return (usage.input ?? 0) + (usage.output ?? 0);
}
function findAggregateOnlyUsageEntry(assistantEntries, turnEntries) {
	if (assistantEntries.length <= 1) return;
	const usageEntries = assistantEntries.filter((entry) => usageDetailsFromUsage(entry.message.usage) !== void 0);
	const usageEntry = usageEntries[0];
	if (!usageEntry || usageEntries.length !== 1 || usageEntry !== assistantEntries.at(-1)) return;
	const aggregateIndex = turnEntries.indexOf(usageEntry);
	return turnEntries.slice(0, aggregateIndex).some((entry) => entry.message.role === "toolResult") ? usageEntry : void 0;
}
const NATIVE_CHILD_MAX_ROLE_CHARS = 256;
function isSupportedNativeChildDiagnosticVersion(event) {
	return event.version === 1;
}
function nativeChildTurnKey(childThreadId, childTurnId) {
	return `${childThreadId}\u0000${childTurnId}`;
}
function nativeChildTraceId(parentTraceId, childThreadId, childTurnId) {
	return generateTraceId([
		"native-child",
		parentTraceId,
		childThreadId,
		childTurnId
	].join("\0"), 0);
}
function nativeChildTraceName(agentId, role) {
	return [
		agentId,
		"native-child",
		role
	].filter(Boolean).join(":");
}
function nativeChildLineage(entry) {
	return entry.nativeChildLineage ??= {
		producerHealthy: true,
		support: "unknown",
		status: "unsupported",
		observations: /* @__PURE__ */ new Map(),
		currentChildTurnIds: /* @__PURE__ */ new Map(),
		pendingChildThreads: /* @__PURE__ */ new Set(),
		childTriggeringToolCallIds: /* @__PURE__ */ new Map(),
		spawnAgentRoles: /* @__PURE__ */ new Map(),
		pendingLifecycleEvents: /* @__PURE__ */ new Map(),
		sourceEventIds: /* @__PURE__ */ new Set(),
		providerCallOwners: /* @__PURE__ */ new Map(),
		mutations: 0,
		pendingJoins: 0,
		admittedEvents: 0,
		duplicateEvents: 0,
		droppedEvents: 0,
		activeChildrenAtRootFinalization: 0,
		partialReasons: /* @__PURE__ */ new Set(),
		drain: "pending",
		finalized: false
	};
}
function markNativeChildPending(entry, childThreadId) {
	nativeChildLineage(entry).pendingChildThreads.add(childThreadId);
}
function clearNativeChildPending(entry, childThreadId) {
	const state = nativeChildLineage(entry);
	state.pendingChildThreads.delete(childThreadId);
	if (state.pendingChildThreads.size === 0 && state.pendingLifecycleEvents.size === 0 && (entry.pendingNativeChildDiagnostics?.length ?? 0) === 0) {
		state.partialReasons.delete("child_observation_pending_spawn_ownership");
		state.partialReasons.delete("child_observation_pending_spawn_tool");
		state.partialReasons.delete("child_observation_unavailable");
	}
}
function rememberNativeChildTriggeringTool(entry, childThreadId, toolCallId) {
	nativeChildLineage(entry).childTriggeringToolCallIds.set(childThreadId, toolCallId);
}
function rememberNativeChildSpawnRole(entry, toolCallId, role) {
	const state = nativeChildLineage(entry);
	const normalizedRole = role.trim();
	const boundedRole = normalizedRole.length <= NATIVE_CHILD_MAX_ROLE_CHARS ? normalizedRole : `${normalizedRole.slice(0, 128)}:${generateTraceId(normalizedRole, 0)}`;
	const existing = state.spawnAgentRoles.get(toolCallId);
	if (existing === boundedRole) return true;
	if (existing) {
		state.partialReasons.add("spawn_role_conflict");
		return false;
	}
	if (!admitNativeChildMutation(entry, "spawn_agent_role")) return false;
	state.spawnAgentRoles.set(toolCallId, boundedRole);
	return true;
}
function noteNativeChildProducerUnhealthy(entry) {
	nativeChildLineage(entry).producerHealthy = false;
}
function admitNativeChildMutation(entry, source) {
	const state = nativeChildLineage(entry);
	if (state.mutations >= 4096) {
		state.droppedEvents += 1;
		state.partialReasons.add("mutation_limit");
		state.partialReasons.add(source);
		return false;
	}
	state.mutations += 1;
	return true;
}
function activeNativeChildCount(entry) {
	let active = 0;
	for (const observation of nativeChildLineage(entry).observations.values()) if (!observation.ended) active += 1;
	return active;
}
function ensureNativeChildObservationState(entry, childThreadId, childTurnId, create) {
	const state = nativeChildLineage(entry);
	const key = nativeChildTurnKey(childThreadId, childTurnId);
	const existing = state.observations.get(key);
	if (existing) return existing;
	if (activeNativeChildCount(entry) >= 64) {
		state.droppedEvents += 1;
		state.partialReasons.add("active_child_limit");
		return;
	}
	if (!admitNativeChildMutation(entry, "child_observation")) return;
	const observation = create();
	if (!observation) return;
	state.currentChildTurnIds.set(childThreadId, childTurnId);
	state.observations.set(key, observation);
	return observation;
}
function findNativeChildObservation(entry, childThreadId, childTurnId) {
	const state = nativeChildLineage(entry);
	const resolvedTurnId = childTurnId ?? state.currentChildTurnIds.get(childThreadId);
	return resolvedTurnId ? state.observations.get(nativeChildTurnKey(childThreadId, resolvedTurnId)) : void 0;
}
function rememberNativeChildProviderOwner(entry, providerCallId, childThreadId, childTurnId) {
	const state = nativeChildLineage(entry);
	const ownerKey = nativeChildTurnKey(childThreadId, childTurnId);
	const existing = state.providerCallOwners.get(providerCallId);
	if (existing === ownerKey) return true;
	if (existing) {
		state.partialReasons.add("provider_owner_conflict");
		return false;
	}
	if (!admitNativeChildMutation(entry, "provider_call_owner")) return false;
	state.providerCallOwners.set(providerCallId, ownerKey);
	return true;
}
function noteNativeChildPendingJoin(entry) {
	const state = nativeChildLineage(entry);
	if (state.pendingJoins >= 512) {
		state.droppedEvents += 1;
		state.partialReasons.add("pending_join_limit");
		return;
	}
	state.pendingJoins += 1;
	state.partialReasons.add("partial_parenting");
}
function noteNativeChildPartial(entry, reason) {
	const state = nativeChildLineage(entry);
	state.partialReasons.add(reason);
	if (state.status === "complete") state.status = "partial";
}
function noteNativeChildPostFinalization(entry) {
	const state = nativeChildLineage(entry);
	noteNativeChildPartial(entry, "post_finalization_event");
	state.droppedEvents += 1;
}
function admitNativeChildLifecycle(entry, event, options) {
	const state = nativeChildLineage(entry);
	if (state.finalized && !options?.allowAfterRootFinalization) {
		state.droppedEvents += 1;
		state.partialReasons.add("post_finalization_event");
		return false;
	}
	if (state.sourceEventIds.has(event.sourceEventId)) {
		state.duplicateEvents += 1;
		return false;
	}
	if (!admitNativeChildMutation(entry, "lifecycle")) return false;
	state.sourceEventIds.add(event.sourceEventId);
	state.admittedEvents += 1;
	state.support = "supported";
	state.status = "partial";
	return true;
}
function applyNativeChildTurnStatus(entry, event, producerHealthy) {
	const state = nativeChildLineage(entry);
	state.support = event.support;
	state.capability = {
		eventVersions: [event.version],
		authoritativeStart: event.authoritativeStart,
		authoritativeTerminal: event.authoritativeTerminal,
		providerCallOwnership: event.providerCallOwnership,
		toolCallOwnership: event.toolCallOwnership
	};
	state.drain = event.drain;
	state.admittedEvents = Math.max(state.admittedEvents, event.counts.admitted);
	state.duplicateEvents = Math.max(state.duplicateEvents, event.counts.duplicates);
	state.droppedEvents = Math.max(state.droppedEvents, event.counts.dropped);
	state.activeChildrenAtRootFinalization = event.counts.activeChildren;
	for (const reason of event.partialReasons ?? []) state.partialReasons.add(reason);
	if (!producerHealthy || !state.producerHealthy) state.partialReasons.add("producer_unhealthy");
	if ((entry.pendingObservationDeliveryFailures?.size ?? 0) > 0) state.partialReasons.add("observation_delivery_incomplete");
	if (event.support === "unsupported") {
		if (state.observations.size > 0 || state.providerCallOwners.size > 0) {
			state.support = "supported";
			state.status = "partial";
			state.partialReasons.add("lifecycle_capability_absent");
		} else state.status = "unsupported";
		return;
	}
	const capability = state.capability;
	const terminalCoverage = capability?.authoritativeTerminal || event.counts.activeChildren > 0;
	state.status = capability?.authoritativeStart && terminalCoverage && capability.providerCallOwnership && capability.toolCallOwnership && event.drain === "completed" && event.counts.dropped === 0 && state.partialReasons.size === 0 ? "complete" : "partial";
}
function finalizeNativeChildLineage(entry, producerHealthy) {
	const state = nativeChildLineage(entry);
	state.finalized = true;
	if (state.support === "supported" && [...state.pendingLifecycleEvents.keys()].some((childThreadId) => !state.currentChildTurnIds.has(childThreadId))) noteNativeChildPartial(entry, "child_turn_identity_unavailable");
	if (state.support === "supported" && [...state.observations.values()].some((observation) => observation.ended && (observation.executionContextCallIds?.size ?? 0) === 0)) noteNativeChildPartial(entry, "child_context_unavailable");
	if ((entry.pendingObservationDeliveryFailures?.size ?? 0) > 0) noteNativeChildPartial(entry, "observation_delivery_incomplete");
	if (state.support === "supported" && state.drain === "pending") {
		state.partialReasons.add("missing_turn_status");
		state.status = "partial";
	}
	if ((!producerHealthy || !state.producerHealthy) && state.support === "supported") {
		state.partialReasons.add("producer_unhealthy");
		state.status = "partial";
	}
}
function nativeChildLifecycleMetadata(event) {
	return {
		sourceEventId: event.sourceEventId,
		childThreadId: event.childThreadId,
		...event.triggeringToolCallId ? { triggeringToolCallId: event.triggeringToolCallId } : {},
		lifecycle: event.lifecycle,
		parentThreadId: event.parentThreadId,
		parentTurnId: event.parentTurnId,
		...event.childTurnId ? { childTurnId: event.childTurnId } : {},
		...event.role ? { role: event.role } : {},
		...event.model ? { model: event.model } : {},
		...event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {},
		...event.depth !== void 0 ? { depth: event.depth } : {},
		...event.outcome ? { outcome: event.outcome } : {}
	};
}
function nativeChildLineageMetadata(entry) {
	const state = nativeChildLineage(entry);
	const observations = [...state.observations.values()];
	const roles = [...new Set(observations.map((observation) => observation.role).filter((role) => typeof role === "string"))].toSorted((left, right) => left.localeCompare(right));
	const models = [...new Set(observations.map((observation) => observation.model).filter((model) => typeof model === "string"))].toSorted((left, right) => left.localeCompare(right));
	const childrenWithContext = observations.filter((observation) => (observation.executionContextCallIds?.size ?? 0) > 0).length;
	const contextRequestCount = observations.reduce((total, observation) => total + (observation.executionContextCallIds?.size ?? 0), 0);
	return {
		status: state.status,
		support: state.support,
		drain: state.drain,
		childCount: state.observations.size,
		admittedEvents: state.admittedEvents,
		duplicateEvents: state.duplicateEvents,
		droppedEvents: state.droppedEvents,
		activeChildrenAtRootFinalization: state.activeChildrenAtRootFinalization,
		observationMutations: state.mutations,
		pendingOwnershipJoins: state.pendingJoins,
		partialReasons: [...state.partialReasons].toSorted().slice(0, 16),
		...observations.length > 0 ? {
			childTraceLinks: observations.map((observation) => ({
				childTraceId: observation.id,
				spawnObservationId: observation.spawnObservationId,
				childThreadId: observation.childThreadId,
				childTurnId: observation.childTurnId
			})),
			childContext: {
				availableChildren: childrenWithContext,
				unavailableChildren: observations.length - childrenWithContext,
				requestCount: contextRequestCount,
				...roles.length > 0 ? { roles } : {},
				...models.length > 0 ? { models } : {}
			}
		} : {},
		...state.capability ? { capability: state.capability } : {}
	};
}
//#endregion
//#region extensions/openclaw-langfuse/src/observations.ts
function entryIndex$1(entries, entry, fallback) {
	const index = entries.indexOf(entry);
	return index >= 0 ? index : fallback;
}
function turnStartIndex$1(allEntries, turnEntries) {
	const firstTurnEntry = turnEntries[0];
	return firstTurnEntry ? entryIndex$1(allEntries, firstTurnEntry, 0) : 0;
}
function hasReportedUsageFields(usage) {
	return !!usage && Object.values(usage).some((value) => Number.isFinite(value));
}
function toolResultEntriesById$1(turnEntries) {
	const resultEntries = /* @__PURE__ */ new Map();
	for (const entry of turnEntries) {
		const msg = entry.message;
		if (msg.role !== "toolResult" && msg.role !== "tool") continue;
		const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : typeof msg.tool_call_id === "string" ? msg.tool_call_id : void 0;
		if (toolCallId && !resultEntries.has(toolCallId)) resultEntries.set(toolCallId, entry);
	}
	return resultEntries;
}
function toolResultOutput$1(msg) {
	if ("content" in msg) return msg.content;
	if ("result" in msg) return msg.result;
}
function countToolCallsFromMessages(messages) {
	const toolCallIds = /* @__PURE__ */ new Set();
	for (const msg of messages) {
		const m = msg;
		if (m.role === "assistant" && Array.isArray(m.content)) for (const block of m.content) {
			const b = block;
			if (isToolCallBlock(b) && b.id) toolCallIds.add(String(b.id));
		}
	}
	return toolCallIds.size;
}
/**
* Build Langfuse generation observations from session entries.
* Extracted from agentEnd so the same logic can be used for startup recovery.
* Returns aggregated counts and usage for trace metadata.
*/
async function buildObservationsFromEntries(trace, traceId, turnEntries, allEntries, options, logger) {
	const { entryTimestamp, storedUsage, promptClient, redactEnabled } = options;
	const lastTurnEntry = turnEntries.at(-1);
	const lastTurnEntryIndex = lastTurnEntry ? entryIndex$1(allEntries, lastTurnEntry, allEntries.length - 1) : allEntries.length - 1;
	const contextEntries = allEntries.slice(0, lastTurnEntryIndex + 1);
	const firstTurnEntryIndex = turnStartIndex$1(contextEntries, turnEntries);
	const canonicalContextMessages = contextEntries.filter(isTraceContextInputEntry).map((entry) => buildApiMessage(entry.message)).filter((message) => message.role !== "system");
	const priorMessages = contextEntries.slice(0, firstTurnEntryIndex).filter(isTraceContextInputEntry).map((entry) => buildApiMessage(entry.message)).filter((message) => message.role !== "system");
	const normalizedContext = normalizeModelCallInput({
		model: options.lastModel,
		systemPrompt: options.systemPrompt,
		messages: canonicalContextMessages,
		...priorMessages.length > 0 ? { priorMessages } : {},
		redactEnabled
	});
	let llmCallCount = 0;
	let toolCallCount = 0;
	let lastAssistantText;
	let lastProvider = options.lastProvider;
	let lastModel = options.lastModel;
	let prevTimestamp;
	const totalUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0
	};
	const reportedUsageFields = {
		input: false,
		output: false,
		cacheRead: false,
		cacheWrite: false,
		total: false
	};
	const completedGenerations = /* @__PURE__ */ new Map();
	const completedGenerationIds = /* @__PURE__ */ new Map();
	let hasReportedUsage = false;
	let observationBarrierIncomplete = false;
	const toolResultEntries = toolResultEntriesById$1(turnEntries);
	const emittedToolCallIds = /* @__PURE__ */ new Set();
	const assistantEntries = turnEntries.filter(isTraceableAssistantEntry);
	const assistantCount = assistantEntries.length;
	const aggregateOnlyUsageEntry = findAggregateOnlyUsageEntry(assistantEntries, turnEntries);
	const aggregateOnlyUsage = aggregateOnlyUsageEntry?.message.usage;
	if (hasReportedUsageFields(aggregateOnlyUsage)) {
		hasReportedUsage = true;
		addUsageToTotals(totalUsage, aggregateOnlyUsage);
		markReportedUsageFields(reportedUsageFields, aggregateOnlyUsage);
	}
	for (const te of turnEntries) {
		const msg = te.message;
		if (isTraceableAssistantEntry(te)) {
			llmCallCount += 1;
			const isLast = llmCallCount === assistantCount;
			const assistantTs = assistantEndTimestamp(te);
			const startTime = prevTimestamp ? new Date(prevTimestamp) : new Date(entryTimestamp);
			const endTime = new Date(assistantTs);
			const output = buildGenerationOutput(msg.content, redactEnabled);
			const currentIdx = entryIndex$1(contextEntries, te, contextEntries.length);
			const prevAssistantEntry = llmCallCount > 1 ? assistantEntries.at(llmCallCount - 2) : void 0;
			const deltaStart = prevAssistantEntry ? entryIndex$1(contextEntries, prevAssistantEntry, firstTurnEntryIndex) : firstTurnEntryIndex;
			const deltaMessages = contextEntries.slice(deltaStart, currentIdx).filter(isTraceContextInputEntry).map((e) => buildApiMessage(e.message));
			const genInput = normalizeModelCallInput({
				model: String(msg.model ?? options.lastModel ?? "unknown"),
				messages: deltaMessages,
				previousMessages: [],
				redactEnabled
			}).generationInput;
			const msgUsage = msg.usage;
			const usageForGeneration = aggregateOnlyUsageEntry === te ? void 0 : msgUsage;
			let genUsage;
			if (hasReportedUsageFields(usageForGeneration)) {
				hasReportedUsage = true;
				genUsage = usageDetailsFromUsage(usageForGeneration);
				addUsageToTotals(totalUsage, usageForGeneration);
				markReportedUsageFields(reportedUsageFields, usageForGeneration);
			} else if (isLast && storedUsage && !aggregateOnlyUsageEntry) {
				genUsage = usageDetailsFromUsage(storedUsage);
				totalUsage.input += storedUsage.input ?? 0;
				totalUsage.output += storedUsage.output ?? 0;
				totalUsage.cacheRead += storedUsage.cacheRead ?? 0;
				totalUsage.cacheWrite += storedUsage.cacheWrite ?? 0;
				totalUsage.total += storedUsage.total ?? 0;
				hasReportedUsage ||= hasReportedUsageFields(storedUsage);
				markReportedUsageFields(reportedUsageFields, storedUsage);
			}
			const rawModel = String(msg.model ?? options.lastModel ?? "unknown");
			const provider = String(msg.provider ?? options.lastProvider ?? "");
			const model = qualifiedModel(provider, rawModel);
			const generationId = options.generationIdsBySlot?.get(llmCallCount) ?? generateObservationId(traceId, "gen", llmCallCount);
			const genData = {
				id: generationId,
				name: `llm-call-${llmCallCount}`,
				model,
				startTime,
				endTime,
				input: genInput,
				output: truncatePayload(output),
				usageDetails: genUsage,
				...(() => {
					const batchCostObj = msgUsage?.cost;
					return batchCostObj && typeof batchCostObj === "object" && ((batchCostObj.input ?? 0) > 0 || (batchCostObj.output ?? 0) > 0 || (batchCostObj.total ?? 0) > 0) ? { costDetails: {
						input: batchCostObj.input ?? 0,
						output: batchCostObj.output ?? 0,
						total: batchCostObj.total ?? 0
					} } : {};
				})(),
				metadata: {
					provider,
					model: msg.model,
					stopReason: msg.stopReason,
					...msg.errorMessage ? { errorMessage: msg.errorMessage } : {}
				},
				...msg.stopReason === "error" && msg.errorMessage ? {
					statusMessage: String(msg.errorMessage),
					level: "ERROR"
				} : {},
				...promptClient ? { prompt: promptClient } : {}
			};
			const generationStartEvent = {
				e: "gen-start",
				traceId,
				id: generationId,
				llmCall: llmCallCount,
				model,
				ts: startTime.toISOString()
			};
			const generationEndEvent = {
				e: "gen-end",
				traceId,
				id: generationId,
				ts: endTime.toISOString()
			};
			if (options.recordObservationEvent?.(generationStartEvent, "batch generation start") === false || options.recordObservationEvent?.(generationEndEvent, "batch generation end") === false || await options.onBeforeSdkEnqueue?.(generationId, "generation-create", "batch generation") === false) {
				observationBarrierIncomplete = true;
				continue;
			}
			const generation = trace.generation(genData);
			completedGenerations.set(llmCallCount, generation);
			completedGenerationIds.set(llmCallCount, generationId);
			if (Array.isArray(msg.content)) for (const block of msg.content) {
				if (!isToolCallBlock(block) || typeof block.id !== "string") continue;
				const toolCallId = block.id;
				if (emittedToolCallIds.has(toolCallId) || options.existingToolCallIds?.has(toolCallId)) continue;
				emittedToolCallIds.add(toolCallId);
				const existingSpanId = options.toolSpanIdsByCallId?.get(toolCallId) ?? generateObservationId(traceId, "span", toolCallId);
				const toolName = String(block.name ?? "unknown");
				const resultEntry = toolResultEntries.get(toolCallId);
				const isError = resultEntry?.message.isError === true;
				const spanStartTime = new Date(messageTimestamp(te));
				const spanEndTime = new Date(resultEntry ? messageTimestamp(resultEntry) : assistantEndTimestamp(te));
				if (options.recordObservationEvent?.({
					e: "span-start",
					traceId,
					id: existingSpanId,
					tool: toolName,
					toolCallId,
					ts: spanStartTime.toISOString()
				}, "batch tool span start") === false || await options.onBeforeSdkEnqueue?.(existingSpanId, "span-create", "batch tool span") === false) {
					observationBarrierIncomplete = true;
					continue;
				}
				const span = trace.span({
					id: existingSpanId,
					name: `tool:${toolName}`,
					startTime: spanStartTime,
					input: redactObject(truncatePayload(block.input ?? block.args ?? block.arguments ?? {}), redactEnabled),
					metadata: {
						toolName,
						toolCallId,
						source: "startup-recovery"
					}
				});
				if (options.recordObservationEvent?.({
					e: "span-end",
					traceId,
					id: existingSpanId,
					ts: spanEndTime.toISOString()
				}, "batch tool span end") === false || await options.onBeforeSdkEnqueue?.(existingSpanId, "span-update", "batch tool span update") === false) {
					observationBarrierIncomplete = true;
					continue;
				}
				span.update({
					endTime: spanEndTime,
					output: redactObject(truncatePayload(resultEntry ? toolResultOutput$1(resultEntry.message) : void 0), redactEnabled),
					metadata: {
						toolName,
						toolCallId,
						source: "startup-recovery",
						...isError ? { isError: true } : {}
					},
					...isError ? {
						level: "ERROR",
						statusMessage: "tool returned an error result"
					} : {}
				});
			}
			const text = extractTextContent(msg.content);
			if (text) lastAssistantText = text;
			lastProvider = provider;
			lastModel = model;
		}
		if (isTraceableAssistantEntry(te)) prevTimestamp = assistantEndTimestamp(te);
		else if (isTraceContextInputEntry(te)) prevTimestamp = messageTimestamp(te);
	}
	toolCallCount = countToolCallsFromMessages(turnEntries.map((entry) => entry.message));
	logger?.debug?.(`Langfuse: counted ${toolCallCount} tool call(s) from JSONL`);
	if (!hasReportedUsage) {
		totalUsage.input = 0;
		totalUsage.output = 0;
		totalUsage.cacheRead = 0;
		totalUsage.cacheWrite = 0;
		totalUsage.total = 0;
	}
	return {
		llmCallCount,
		toolCallCount,
		lastAssistantText,
		lastProvider,
		lastModel,
		totalUsage,
		reportedUsageFields,
		completedGenerations,
		completedGenerationIds,
		hasReportedUsage,
		observationBarrierIncomplete,
		modelContextMetadata: normalizedContext.traceMetadata,
		...normalizedContext.priorConversation !== void 0 ? { priorConversation: normalizedContext.priorConversation } : {}
	};
}
function markReportedUsageFields(fields, usage) {
	fields.input ||= typeof usage.input === "number" && Number.isFinite(usage.input);
	fields.output ||= typeof usage.output === "number" && Number.isFinite(usage.output);
	fields.cacheRead ||= typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead);
	fields.cacheWrite ||= typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite);
	fields.total ||= typeof usage.total === "number" && Number.isFinite(usage.total) || typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) || fields.input || fields.output;
}
//#endregion
//#region extensions/openclaw-langfuse/src/session-transcript-compat.ts
function optionalExport(module, name) {
	const value = module[name];
	return typeof value === "function" ? value : void 0;
}
/** Resolves a 7.1 session key from the file-backed sessions.json registry. */
function resolveTranscriptSessionKeyBySessionId(params) {
	const publicResolver = optionalExport(sessionStoreRuntime, "resolveTranscriptSessionKeyBySessionId");
	if (publicResolver) return publicResolver(params);
	const loadSessionStore = optionalExport(sessionStoreRuntime, "loadSessionStore");
	const resolveStorePath = optionalExport(sessionStoreRuntime, "resolveStorePath");
	if (!loadSessionStore || !resolveStorePath) return;
	const store = loadSessionStore(resolveStorePath(void 0, {
		agentId: params.agentId,
		env: params.env
	}), {
		hydrateSkillPromptRefs: false,
		skipCache: true
	});
	return Object.entries(store).find(([, entry]) => entry?.sessionId === params.sessionId)?.[0];
}
function projectLegacyVisibleEntries(events) {
	const entries = [];
	let seq = 0;
	for (const event of events) {
		if (!event || typeof event !== "object" || Array.isArray(event)) continue;
		const parsed = event;
		if (!parsed.message || typeof parsed.message !== "object") continue;
		seq += 1;
		const entryId = typeof parsed.id === "string" ? parsed.id : `entry-${seq}`;
		const createdAt = typeof parsed.timestamp === "string" || typeof parsed.timestamp === "number" ? parsed.timestamp : (/* @__PURE__ */ new Date()).toISOString();
		entries.push({
			entryId,
			...typeof parsed.parentId === "string" ? { parentId: parsed.parentId } : {},
			seq,
			createdAt,
			message: parsed.message
		});
	}
	return entries;
}
function readLegacyVisibleEntries(sessionFile) {
	let raw;
	try {
		raw = fs.readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	const events = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
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
async function readVisibleSessionTranscriptMessageEntries(params) {
	const publicReader = optionalExport(sessionTranscriptRuntime, "readVisibleSessionTranscriptMessageEntries");
	if (publicReader) return await publicReader(params);
	const readLegacyEvents = optionalExport(sessionTranscriptRuntime, "readSessionTranscriptEvents");
	if (readLegacyEvents) return projectLegacyVisibleEntries(await readLegacyEvents(params));
	const resolveLegacyTarget = optionalExport(sessionTranscriptRuntime, "resolveSessionTranscriptLegacyFileTarget");
	if (resolveLegacyTarget) return readLegacyVisibleEntries((await resolveLegacyTarget(params)).sessionFile);
	const stateDir = params.env?.OPENCLAW_STATE_DIR ?? process.env.OPENCLAW_STATE_DIR;
	if (!stateDir || !params.agentId) return [];
	return readLegacyVisibleEntries(path.join(stateDir, "agents", params.agentId, "sessions", `${params.sessionId}.jsonl`));
}
//#endregion
//#region extensions/openclaw-langfuse/src/trace-ledger.ts
const TRACE_LEDGER_NAMESPACE = "trace-ledger-v1";
const TRACE_LEDGER_MAX_ENTRIES = 4e4;
const TRACE_LEDGER_TTL_MS = 2880 * 60 * 1e3;
const configuredStores = /* @__PURE__ */ new Map();
const fallbackStores = /* @__PURE__ */ new Map();
function storeScope(stateDir) {
	return stateDir?.trim() || "volatile";
}
function createMemoryStore() {
	const records = /* @__PURE__ */ new Map();
	const sweep = () => {
		const now = Date.now();
		for (const [key, entry] of records) if (entry.expiresAt !== void 0 && entry.expiresAt <= now) records.delete(key);
	};
	const write = (key, value, ttlMs = TRACE_LEDGER_TTL_MS) => {
		const createdAt = Date.now();
		records.set(key, {
			key,
			value,
			createdAt,
			expiresAt: createdAt + ttlMs
		});
	};
	return {
		register(key, value, options) {
			sweep();
			write(key, value, options?.ttlMs);
		},
		registerIfAbsent(key, value, options) {
			sweep();
			if (records.has(key)) return false;
			write(key, value, options?.ttlMs);
			return true;
		},
		update(key, updateValue, options) {
			sweep();
			const next = updateValue(records.get(key)?.value);
			if (next === void 0) return false;
			write(key, next, options?.ttlMs);
			return true;
		},
		lookup(key) {
			sweep();
			return records.get(key)?.value;
		},
		consume(key) {
			sweep();
			const value = records.get(key)?.value;
			records.delete(key);
			return value;
		},
		delete(key) {
			sweep();
			return records.delete(key);
		},
		entries() {
			sweep();
			return [...records.values()].toSorted((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
		},
		clear() {
			records.clear();
		}
	};
}
/** Binds the plugin-owned SQLite store supplied by the public runtime facade. */
function configureTraceLedgerStore(stateDir, store) {
	configuredStores.set(storeScope(stateDir), store);
}
function resolveStore(stateDir) {
	const scope = storeScope(stateDir);
	const configuredStore = configuredStores.get(scope);
	if (configuredStore) return configuredStore;
	let store = fallbackStores.get(scope);
	if (!store) {
		store = createMemoryStore();
		fallbackStores.set(scope, store);
	}
	return store;
}
function traceKey(traceId) {
	return `trace:${traceId}`;
}
function observationKey(traceId, observationId) {
	return `observation:${traceId}:${observationId}`;
}
function readRecords(stateDir, logger) {
	try {
		return resolveStore(stateDir).entries().map((entry) => entry.value);
	} catch (error) {
		logger?.warn?.(`Langfuse: failed to read trace ledger — ${String(error)}`);
		return [];
	}
}
function readTraceLedgerTrace(stateDir, traceId, logger) {
	try {
		const record = resolveStore(stateDir).lookup(traceKey(traceId));
		return record?.kind === "trace" ? record : void 0;
	} catch (error) {
		logger?.warn?.(`Langfuse: failed to read trace ${traceId} from ledger — ${String(error)}`);
		return;
	}
}
function listTraceLedgerTraces(stateDir, logger) {
	return readRecords(stateDir, logger).filter((record) => record.kind === "trace").toSorted((left, right) => left.startedAt - right.startedAt);
}
function readNextTraceStartTimestamp(stateDir, trace, logger) {
	return listTraceLedgerTraces(stateDir, logger).find((candidate) => candidate.agentId === trace.agentId && candidate.sessionId === trace.sessionId && candidate.traceId !== trace.traceId && candidate.startedAt > trace.startedAt)?.startedAt;
}
function writeTraceMarker(stateDir, agentId, sessionId, type, traceId, logger, options) {
	if (!sessionId) return true;
	try {
		const store = resolveStore(stateDir);
		const current = store.lookup(traceKey(traceId));
		const existing = current?.kind === "trace" ? current : void 0;
		const startedAt = existing?.startedAt ?? options?.startedAt ?? Date.now();
		const status = type === "end" ? "ended" : existing?.status ?? "open";
		store.register(traceKey(traceId), {
			kind: "trace",
			traceId,
			agentId,
			sessionId,
			startedAt,
			status,
			...options?.traceKind || existing?.traceKind ? { traceKind: options?.traceKind ?? existing?.traceKind } : {},
			...options?.sessionKey || existing?.sessionKey ? { sessionKey: options?.sessionKey ?? existing?.sessionKey } : {},
			...options?.parentTraceId || existing?.parentTraceId ? { parentTraceId: options?.parentTraceId ?? existing?.parentTraceId } : {},
			...options?.spawnObservationId || existing?.spawnObservationId ? { spawnObservationId: options?.spawnObservationId ?? existing?.spawnObservationId } : {},
			...options?.childThreadId || existing?.childThreadId ? { childThreadId: options?.childThreadId ?? existing?.childThreadId } : {},
			...options?.childTurnId || existing?.childTurnId ? { childTurnId: options?.childTurnId ?? existing?.childTurnId } : {},
			...options?.correlationKey || existing?.correlationKey ? { correlationKey: options?.correlationKey ?? existing?.correlationKey } : {},
			...existing?.recoveryAttempts !== void 0 ? { recoveryAttempts: existing.recoveryAttempts } : {},
			...existing?.recoveryOutcome ? { recoveryOutcome: existing.recoveryOutcome } : {},
			...existing?.abandonmentReason ? { abandonmentReason: existing.abandonmentReason } : {}
		});
		return true;
	} catch (error) {
		logger?.warn?.(`Langfuse: failed to write trace marker (${type}) for trace ${traceId} — ${String(error)}`);
		return false;
	}
}
function writeTraceRecoveryMarker(stateDir, agentId, sessionId, traceId, attempt, outcome, logger, reason) {
	if (!sessionId) return true;
	try {
		const store = resolveStore(stateDir);
		const current = store.lookup(traceKey(traceId));
		const existing = current?.kind === "trace" ? current : void 0;
		store.register(traceKey(traceId), {
			kind: "trace",
			traceId,
			agentId,
			sessionId,
			startedAt: existing?.startedAt ?? Date.now(),
			status: outcome === "abandoned" ? "abandoned" : existing?.status ?? "open",
			...existing?.traceKind ? { traceKind: existing.traceKind } : {},
			...existing?.sessionKey ? { sessionKey: existing.sessionKey } : {},
			...existing?.parentTraceId ? { parentTraceId: existing.parentTraceId } : {},
			...existing?.spawnObservationId ? { spawnObservationId: existing.spawnObservationId } : {},
			...existing?.childThreadId ? { childThreadId: existing.childThreadId } : {},
			...existing?.childTurnId ? { childTurnId: existing.childTurnId } : {},
			...existing?.correlationKey ? { correlationKey: existing.correlationKey } : {},
			recoveryAttempts: Math.max(attempt, existing?.recoveryAttempts ?? 0),
			recoveryOutcome: outcome,
			...reason ? { abandonmentReason: reason } : {}
		});
		return true;
	} catch (error) {
		logger?.warn?.(`Langfuse: failed to write trace recovery marker (${outcome}) for trace ${traceId} — ${String(error)}`);
		return false;
	}
}
function readOpenTraceMarkerByCorrelation(stateDir, agentId, sessionId, correlationKey) {
	const record = listTraceLedgerTraces(stateDir).toReversed().find((record) => record.agentId === agentId && record.sessionId === sessionId && record.correlationKey === correlationKey && record.status === "open");
	return record ? {
		traceId: record.traceId,
		timestamp: record.startedAt
	} : void 0;
}
function observationRecordFromEvent(event, current) {
	const observationKind = event.e === "gen-start" || event.e === "gen-end" ? "generation" : "span";
	if (event.e === "gen-start") return {
		kind: "observation",
		traceId: event.traceId,
		id: event.id,
		observationKind,
		startedAt: event.ts,
		...current?.completedAt ? { completedAt: current.completedAt } : {},
		llmCall: event.llmCall,
		model: event.model
	};
	if (event.e === "span-start") return {
		kind: "observation",
		traceId: event.traceId,
		id: event.id,
		observationKind,
		startedAt: event.ts,
		...current?.completedAt ? { completedAt: current.completedAt } : {},
		tool: event.tool,
		toolCallId: event.toolCallId
	};
	return {
		kind: "observation",
		traceId: event.traceId,
		id: event.id,
		observationKind: current?.observationKind ?? observationKind,
		...current?.startedAt ? { startedAt: current.startedAt } : {},
		completedAt: event.ts,
		...current?.llmCall !== void 0 ? { llmCall: current.llmCall } : {},
		...current?.model ? { model: current.model } : {},
		...current?.tool ? { tool: current.tool } : {},
		...current?.toolCallId ? { toolCallId: current.toolCallId } : {}
	};
}
function writeObservationEvent(stateDir, _agentId, sessionId, event, logger) {
	if (!sessionId) return true;
	try {
		const store = resolveStore(stateDir);
		const key = observationKey(event.traceId, event.id);
		const update = store.update;
		if (update) return update(key, (current) => observationRecordFromEvent(event, current?.kind === "observation" ? current : void 0));
		const current = store.lookup(key);
		store.register(key, observationRecordFromEvent(event, current?.kind === "observation" ? current : void 0));
		return true;
	} catch (error) {
		logger?.warn?.(`Langfuse: failed to write observation event (${event.e}) for trace ${event.traceId} — ${String(error)}`);
		return false;
	}
}
function readObservationEvents(stateDir, _agentId, sessionId, traceId, logger) {
	const createdIds = /* @__PURE__ */ new Set();
	const completedIds = /* @__PURE__ */ new Set();
	const generationIdsBySlot = /* @__PURE__ */ new Map();
	const toolSpanIdsByCallId = /* @__PURE__ */ new Map();
	if (!sessionId) return {
		createdIds,
		completedIds,
		generationIdsBySlot,
		toolSpanIdsByCallId
	};
	for (const record of readRecords(stateDir, logger)) {
		if (record.kind !== "observation" || record.traceId !== traceId) continue;
		if (record.startedAt) createdIds.add(record.id);
		if (record.completedAt) completedIds.add(record.id);
		if (record.llmCall !== void 0) generationIdsBySlot.set(record.llmCall, record.id);
		if (record.toolCallId) toolSpanIdsByCallId.set(record.toolCallId, record.id);
	}
	return {
		createdIds,
		completedIds,
		generationIdsBySlot,
		toolSpanIdsByCallId
	};
}
//#endregion
//#region extensions/openclaw-langfuse/src/session.ts
/**
* Read messages from a session JSONL file on disk.
* Returns entries with timestamps so callers can derive accurate startTime/endTime.
*/
function readSessionMessages(stateDir, agentId, sessionId, logger) {
	if (!stateDir) {
		logger?.warn?.(`Langfuse: no stateDir available, cannot locate session JSONL`);
		return [];
	}
	return readSessionMessagesFromFile(path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`), logger);
}
/** Reads the 7.1 file-backed transcript through the public legacy target adapter. */
async function readSessionMessagesByIdentity(target, logger) {
	try {
		return (await readVisibleSessionTranscriptMessageEntries(target)).map((entry) => {
			const message = entry.message;
			const timestamp = timestampFromPersistedMessage(entry.createdAt, message);
			const sessionEntry = {
				id: entry.entryId,
				timestamp,
				message
			};
			if (entry.parentId) sessionEntry.parentId = entry.parentId;
			return sessionEntry;
		});
	} catch (error) {
		logger?.warn?.(`Langfuse: failed to read session transcript for agent=${target.agentId ?? "unknown"} session=${target.sessionId} — ${String(error)}`);
		return [];
	}
}
function timestampFromPersistedMessage(persistedTimestamp, message) {
	if (typeof persistedTimestamp === "string") {
		const parsed = Date.parse(persistedTimestamp);
		if (Number.isFinite(parsed)) return parsed;
	} else if (typeof persistedTimestamp === "number" && Number.isFinite(persistedTimestamp)) return persistedTimestamp;
	const messageTimestamp = message.timestamp;
	if (typeof messageTimestamp === "string") {
		const parsed = Date.parse(messageTimestamp);
		if (Number.isFinite(parsed)) return parsed;
	} else if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
	return Date.now();
}
function readSessionMessagesFromFile(sessionFile, logger) {
	if (!fs.existsSync(sessionFile)) {
		logger?.warn?.(`Langfuse: session JSONL not found: ${sessionFile}`);
		return [];
	}
	let raw;
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch (err) {
		logger?.warn?.(`Langfuse: failed to read session JSONL: ${sessionFile} — ${String(err)}`);
		return [];
	}
	const lines = raw.split(/\r?\n/);
	const entries = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed?.message) {
				const msg = parsed.message;
				const ts = timestampFromPersistedMessage(parsed.timestamp, msg);
				entries.push({
					...typeof parsed.id === "string" ? { id: parsed.id } : {},
					...typeof parsed.parentId === "string" ? { parentId: parsed.parentId } : {},
					timestamp: ts,
					message: msg
				});
			}
		} catch {}
	}
	return entries;
}
//#endregion
//#region extensions/openclaw-langfuse/src/trace-context.ts
function normalizedRuntimeValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function rememberRuntimeIdentity(entry, identity) {
	const runtime = normalizedRuntimeValue(identity.runtime);
	const runtimeEngine = normalizedRuntimeValue(identity.runtimeEngine);
	const runtimeTransport = normalizedRuntimeValue(identity.runtimeTransport ?? identity.transport);
	if (runtime) entry.lastRuntime = runtime;
	if (runtimeEngine) entry.lastRuntimeEngine = runtimeEngine;
	if (runtimeTransport) entry.lastRuntimeTransport = runtimeTransport;
	const runtimePatch = runtimeMetadata(entry);
	if (Object.keys(runtimePatch).length > 0) entry.traceMetadata = {
		...entry.traceMetadata,
		...runtimePatch
	};
}
function runtimeMetadata(entry) {
	return {
		...entry.lastRuntime ? { runtime: entry.lastRuntime } : {},
		...entry.lastRuntimeEngine ? { runtimeEngine: entry.lastRuntimeEngine } : {},
		...entry.lastRuntimeTransport ? { runtimeTransport: entry.lastRuntimeTransport } : {}
	};
}
function isCodexRuntime(entry) {
	const runtime = entry.lastRuntime?.trim().toLowerCase();
	if (runtime) return runtime === "codex" || runtime.startsWith("codex-");
	return entry.lastProvider?.trim().toLowerCase() === "codex";
}
function completeProviderRequestUsageTotals(entry) {
	const callCount = entry.providerRequestCallIndexes?.size ?? entry.providerRequestCallCount ?? 0;
	if (callCount === 0 || entry.providerRequestCompletedCallIds?.size !== callCount || entry.providerRequestUsages?.size !== callCount) return;
	let input = 0;
	let output = 0;
	let total = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let reasoningTokens = 0;
	let hasCacheRead = false;
	let hasCacheWrite = false;
	let hasReasoningTokens = false;
	for (const usage of entry.providerRequestUsages.values()) {
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		total += usage.totalTokens ?? usage.total ?? 0;
		if (typeof usage.cacheRead === "number") {
			cacheRead += usage.cacheRead;
			hasCacheRead = true;
		}
		if (typeof usage.cacheWrite === "number") {
			cacheWrite += usage.cacheWrite;
			hasCacheWrite = true;
		}
		if (typeof usage.reasoningTokens === "number") {
			reasoningTokens += usage.reasoningTokens;
			hasReasoningTokens = true;
		}
	}
	return {
		input,
		output,
		total,
		...hasCacheRead ? { cacheRead } : {},
		...hasCacheWrite ? { cacheWrite } : {},
		...hasReasoningTokens ? { reasoningTokens } : {}
	};
}
function resolveCurrentGeneration(entry) {
	const generationId = entry.currentGenerationId;
	if (!generationId) return;
	const prefix = `${entry.traceId}-gen-`;
	if (generationId.startsWith(prefix)) {
		const generationIndex = Number(generationId.slice(prefix.length));
		if (Number.isInteger(generationIndex) && generationIndex > 0) {
			const completed = entry.completedGenerations.get(generationIndex);
			if (completed) return completed;
		}
	}
	for (const [generationIndex, completedGenerationId] of entry.completedGenerationIds ?? []) if (completedGenerationId === generationId) return entry.completedGenerations.get(generationIndex);
	for (const [pendingKey, pendingGenerationId] of entry.pendingGenIds) if (pendingGenerationId === generationId) return entry.pendingGenerations.get(pendingKey);
}
const MAX_ENTRIES = 1e3;
const ORPHAN_TTL_MS = 300 * 1e3;
const ACTIVE_ORPHAN_TTL_MS = 1440 * 60 * 1e3;
const TRACE_KEY_SEPARATOR = "\0";
var TraceContextMap = class {
	constructor(onDelete) {
		this.onDelete = onDelete;
		this.map = /* @__PURE__ */ new Map();
		this.primaryKeys = /* @__PURE__ */ new Map();
		this.primaryByStorageKey = /* @__PURE__ */ new Map();
		this.finalizedAt = /* @__PURE__ */ new WeakMap();
		this.sweepInterval = null;
	}
	/** Build composite key from agentId and sessionKey */
	static key(agentId, sessionKey) {
		return `${agentId ?? "unknown"}:${sessionKey ?? "unknown"}`;
	}
	create(key, entry) {
		const now = Date.now();
		const storageKey = this.storageKey(key, entry);
		if (this.map.has(storageKey)) this.deleteStorageKey(storageKey);
		entry.lastUpdatedAt = entry.lastUpdatedAt ?? now;
		if (entry.finalized) this.finalizedAt.set(entry, entry.lastUpdatedAt);
		while (this.map.size >= MAX_ENTRIES) {
			const oldest = this.map.keys().next().value;
			if (typeof oldest !== "string") break;
			this.deleteStorageKey(oldest);
		}
		this.map.set(storageKey, entry);
		this.primaryByStorageKey.set(storageKey, key);
		let keys = this.primaryKeys.get(key);
		if (!keys) {
			keys = /* @__PURE__ */ new Set();
			this.primaryKeys.set(key, keys);
		}
		keys.add(storageKey);
	}
	get(key) {
		const exact = this.map.get(key);
		if (exact) {
			this.touch(exact);
			return exact;
		}
		const entry = this.findByPrimaryKey(key, false) ?? this.findByPrimaryKey(key, true);
		if (entry) this.touch(entry);
		return entry;
	}
	delete(key) {
		if (this.map.has(key)) {
			this.deleteStorageKey(key);
			return;
		}
		const entry = this.findByPrimaryKey(key, false);
		if (entry) this.deleteEntry(entry);
	}
	startSweep() {
		this.sweepInterval = setInterval(() => {
			const now = Date.now();
			for (const [key, entry] of this.map) if (this.isExpired(entry, now)) this.deleteStorageKey(key);
		}, 6e4);
		if (this.sweepInterval.unref) this.sweepInterval.unref();
	}
	stopSweep() {
		if (this.sweepInterval) {
			clearInterval(this.sweepInterval);
			this.sweepInterval = null;
		}
	}
	clear() {
		if (this.onDelete) for (const entry of new Set(this.map.values())) this.onDelete(entry);
		this.map.clear();
		this.primaryKeys.clear();
		this.primaryByStorageKey.clear();
		this.finalizedAt = /* @__PURE__ */ new WeakMap();
	}
	get size() {
		return this.map.size;
	}
	hasActiveEntries() {
		for (const entry of this.map.values()) if (!entry.finalized || [...entry.nativeChildLineage?.observations.values() ?? []].some((observation) => !observation.traceEntry.finalized)) return true;
		return false;
	}
	/** Find entry that has a pending span for the given toolCallId. */
	findByPendingSpan(toolCallId) {
		for (const entry of this.map.values()) if (entry.pendingSpans.has(toolCallId)) {
			this.touch(entry);
			return entry;
		}
	}
	findByTraceId(traceId) {
		for (const entry of this.map.values()) if (entry.traceId === traceId) {
			this.touch(entry);
			return entry;
		}
	}
	storageKey(key, entry) {
		return `${key}${TRACE_KEY_SEPARATOR}${entry.traceId}`;
	}
	deleteEntry(entry) {
		for (const [storageKey, stored] of this.map) if (stored === entry) {
			this.deleteStorageKey(storageKey);
			return;
		}
	}
	deleteStorageKey(storageKey) {
		const entry = this.map.get(storageKey);
		this.map.delete(storageKey);
		const primaryKey = this.primaryByStorageKey.get(storageKey);
		this.primaryByStorageKey.delete(storageKey);
		if (primaryKey) {
			const keys = this.primaryKeys.get(primaryKey);
			keys?.delete(storageKey);
			if (keys?.size === 0) this.primaryKeys.delete(primaryKey);
		}
		if (entry && !this.hasEntryReference(entry)) this.onDelete?.(entry);
	}
	hasEntryReference(entry) {
		for (const stored of this.map.values()) if (stored === entry) return true;
		return false;
	}
	touch(entry) {
		const now = Date.now();
		entry.lastUpdatedAt = now;
		if (entry.finalized && !this.finalizedAt.has(entry)) this.finalizedAt.set(entry, now);
	}
	isExpired(entry, now) {
		const activeChildEntries = [...entry.nativeChildLineage?.observations.values() ?? []].map((observation) => observation.traceEntry).filter((childEntry) => !childEntry.finalized);
		if (activeChildEntries.length > 0) return now - Math.min(...activeChildEntries.map((childEntry) => childEntry.createdAt)) > ACTIVE_ORPHAN_TTL_MS;
		if (!entry.finalized) return now - entry.createdAt > ACTIVE_ORPHAN_TTL_MS;
		let finalizedAt = this.finalizedAt.get(entry);
		if (finalizedAt === void 0) {
			finalizedAt = now;
			this.finalizedAt.set(entry, finalizedAt);
			entry.lastUpdatedAt = Math.max(entry.lastUpdatedAt ?? 0, finalizedAt);
			return false;
		}
		return now - Math.max(finalizedAt, entry.lastUpdatedAt ?? entry.createdAt) > ORPHAN_TTL_MS;
	}
	primaryKeyForStorageKey(storageKey) {
		return this.primaryByStorageKey.get(storageKey) ?? storageKey.split(TRACE_KEY_SEPARATOR)[0] ?? storageKey;
	}
	matchesSessionKey(storageKey, sessionKey) {
		if (!sessionKey) return true;
		return this.primaryKeyForStorageKey(storageKey).endsWith(`:${sessionKey}`);
	}
	matchesLookup(entry, lookup) {
		if (!lookup) return true;
		if (lookup.traceId && entry.traceId !== lookup.traceId) return false;
		if (lookup.runId && !this.entryHasRunId(entry, lookup.runId)) return false;
		return true;
	}
	entryHasRunId(entry, runId) {
		return entry.runIds?.has(runId) === true || entry.pendingGenerations.has(runId) || entry.pendingGenIds.has(runId) || entry.providerRequestCallIndexes?.has(runId) === true || entry.providerRequestCompletedCallIds?.has(runId) === true || entry.providerRequestUsages?.has(runId) === true;
	}
	isNewerForSelection(entry, current) {
		const entryTimestamp = entry.timestamp ?? entry.createdAt;
		const currentTimestamp = current.timestamp ?? current.createdAt;
		if (entryTimestamp !== currentTimestamp) return entryTimestamp > currentTimestamp;
		return entry.createdAt > current.createdAt;
	}
	newest(entries, includeFinalized, lookup) {
		let best;
		for (const entry of entries) {
			if (!includeFinalized && entry.finalized || !this.matchesLookup(entry, lookup)) continue;
			if (!best || this.isNewerForSelection(entry, best)) best = entry;
		}
		return best;
	}
	findByPrimaryKey(primaryKey, includeFinalized) {
		const storageKeys = this.primaryKeys.get(primaryKey);
		if (!storageKeys) return;
		const entries = [];
		for (const storageKey of storageKeys) {
			const entry = this.map.get(storageKey);
			if (entry) entries.push(entry);
		}
		return this.newest(entries, includeFinalized);
	}
	/** Find the most recent non-finalized entry (fallback when ctx.agentId is missing). */
	findActive(sessionKey, lookup) {
		let best;
		for (const [key, entry] of this.map) {
			if (!this.matchesSessionKey(key, sessionKey)) continue;
			if (!entry.finalized && this.matchesLookup(entry, lookup) && (!best || this.isNewerForSelection(entry, best))) best = entry;
		}
		if (best) this.touch(best);
		return best;
	}
	/** Find the most recent entry, including finalized traces for late transcript repair. */
	findRecent(sessionKey, lookup) {
		let best;
		for (const [key, entry] of this.map) {
			if (!this.matchesSessionKey(key, sessionKey)) continue;
			if (this.matchesLookup(entry, lookup) && (!best || this.isNewerForSelection(entry, best))) best = entry;
		}
		if (best) this.touch(best);
		return best;
	}
	/** Find the most recent matching finalized entry for late events that omit a run identifier. */
	findRecentFinalized(sessionKey, predicate = () => true) {
		let best;
		for (const [key, entry] of this.map) {
			if (!entry.finalized || !this.matchesSessionKey(key, sessionKey) || !predicate(entry)) continue;
			if (!best || this.isNewerForSelection(entry, best)) best = entry;
		}
		if (best) this.touch(best);
		return best;
	}
};
//#endregion
//#region extensions/openclaw-langfuse/src/diagnostics.ts
const PENDING_DIAGNOSTIC_TRACE_IDENTITY_TTL_MS = 300 * 1e3;
const PENDING_DIAGNOSTIC_TRACE_IDENTITY_MAX_ENTRIES = 256;
function prunePendingDiagnosticTraceIdentities(pendingTraceIdentities, now = Date.now()) {
	for (const [key, identity] of pendingTraceIdentities) if (now - identity.createdAt > PENDING_DIAGNOSTIC_TRACE_IDENTITY_TTL_MS) pendingTraceIdentities.delete(key);
	while (pendingTraceIdentities.size >= PENDING_DIAGNOSTIC_TRACE_IDENTITY_MAX_ENTRIES) {
		const oldestKey = pendingTraceIdentities.keys().next().value;
		if (oldestKey === void 0) break;
		pendingTraceIdentities.delete(oldestKey);
	}
}
function diagnosticSdkFailureKey(observationId, source) {
	return `sdk:${source}:${observationId}`;
}
function clearDiagnosticSdkFailuresForObservation(entry, observationId) {
	const failures = entry.pendingObservationDeliveryFailures;
	if (!failures) return;
	const suffix = `:${observationId}`;
	for (const failure of failures) if (failure.startsWith("sdk:") && failure.endsWith(suffix)) failures.delete(failure);
}
function prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, observationId, eventType, source) {
	const failureKey = diagnosticSdkFailureKey(observationId, source);
	if (onBeforeSdkEnqueue && !onBeforeSdkEnqueue(entry.traceId, observationId, eventType, source)) {
		(entry.pendingObservationDeliveryFailures ??= /* @__PURE__ */ new Set()).add(failureKey);
		return false;
	}
	entry.pendingObservationDeliveryFailures?.delete(failureKey);
	return true;
}
function pendingDiagnosticTraceIdentityKey(key, diagEvt) {
	return `${key}\u0000${diagnosticString(diagEvt.runId) ?? diagnosticString(diagEvt.callId) ?? "unknown"}`;
}
function diagnosticChannel(diagEvt) {
	return String(diagEvt.channel ?? "");
}
function diagnosticString(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : void 0;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
}
function nativeChildDiagnosticMetadata(diagEvt) {
	const nativeChildThreadId = diagnosticString(diagEvt.nativeChildThreadId);
	const nativeChildTurnId = diagnosticString(diagEvt.nativeChildTurnId);
	const parentTurnId = diagnosticString(diagEvt.parentTurnId);
	const triggeringProviderCallId = diagnosticString(diagEvt.triggeringProviderCallId);
	return {
		...nativeChildThreadId ? { nativeChildThreadId } : {},
		...nativeChildTurnId ? { nativeChildTurnId } : {},
		...parentTurnId ? { parentTurnId } : {},
		...triggeringProviderCallId ? { triggeringProviderCallId } : {}
	};
}
function providerGenerationForCall(entry, providerCallId) {
	const pending = entry.pendingGenerations.get(providerCallId);
	if (pending) return pending;
	const generationIndex = entry.providerRequestGenerationIndexes?.get(providerCallId) ?? entry.providerRequestCallIndexes?.get(providerCallId);
	return generationIndex === void 0 ? void 0 : entry.completedGenerations.get(generationIndex);
}
function nativeChildGenerationName(_entry, _childThreadId, fallbackIndex, _callId) {
	return `llm-call-${fallbackIndex}`;
}
function diagnosticRuntimeMetadata(diagEvt) {
	return {
		runtime: diagnosticString(diagEvt.runtime),
		runtimeEngine: diagnosticString(diagEvt.runtimeEngine),
		runtimeTransport: diagnosticString(diagEvt.transport)
	};
}
function diagnosticFallbackSessionKey(diagEvt) {
	return `diagnostic:${diagnosticString(diagEvt.sessionId) ?? "missing-session"}:${diagnosticString(diagEvt.turnId) ?? diagnosticString(diagEvt.turnKey) ?? diagnosticString(diagEvt.messageId) ?? diagnosticString(diagEvt.runId) ?? diagnosticString(diagEvt.callId) ?? diagnosticString(diagEvt.toolCallId) ?? diagnosticString(diagEvt.seq) ?? diagnosticString(diagEvt.ts) ?? "missing-turn"}`;
}
function diagnosticSessionKey(diagEvt) {
	return diagnosticString(diagEvt.sessionKey) ?? diagnosticFallbackSessionKey(diagEvt);
}
function diagnosticAgentId(diagEvt, sessionKey) {
	const explicitAgentId = diagnosticString(diagEvt.agentId);
	if (explicitAgentId) return explicitAgentId;
	return sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] ?? "unknown" : "unknown";
}
function getOrCreateDiagnosticTraceEntry(args) {
	const { langfuse, contextMap, config, promptManager, diagEvt, sessionKey, agentId, key, stateDir, logger, onBeforeSdkEnqueue, pendingTraceIdentities } = args;
	const existing = contextMap.get(key);
	if (existing && !existing.finalized) return existing;
	const pendingKey = pendingDiagnosticTraceIdentityKey(key, diagEvt);
	let identity = pendingTraceIdentities.get(pendingKey);
	if (!identity) {
		prunePendingDiagnosticTraceIdentities(pendingTraceIdentities);
		const sessionId = String(diagEvt.sessionId ?? "");
		const persistedMarker = readOpenTraceMarkerByCorrelation(stateDir, agentId, sessionId, pendingKey);
		const timestamp = persistedMarker?.timestamp ?? Date.now();
		const traceId = persistedMarker?.traceId ?? generateTraceId(sessionKey, timestamp);
		const tags = [
			agentId,
			diagnosticChannel(diagEvt),
			...config.tracing?.tags ?? []
		].filter(Boolean);
		const traceMetadata = {
			sessionId: diagEvt.sessionId,
			sessionKey,
			agentId,
			channel: diagEvt.channel,
			timestamp,
			source: "diagnostic-event"
		};
		if (!persistedMarker && !writeTraceMarker(stateDir, agentId, sessionId, "start", traceId, logger, { correlationKey: pendingKey })) return;
		identity = {
			traceId,
			timestamp,
			tags,
			traceMetadata,
			createdAt: Date.now()
		};
		pendingTraceIdentities.set(pendingKey, identity);
	}
	if (onBeforeSdkEnqueue && !onBeforeSdkEnqueue(identity.traceId, identity.traceId, "trace-create", "diagnostic trace create")) return;
	const trace = langfuse.trace({
		id: identity.traceId,
		name: agentId,
		sessionId: sessionKey,
		tags: identity.tags,
		metadata: identity.traceMetadata
	});
	const runId = diagnosticString(diagEvt.runId);
	const entry = {
		trace,
		traceId: identity.traceId,
		traceMetadata: identity.traceMetadata,
		llmCallCount: 0,
		toolCallCount: 0,
		pendingGenerations: /* @__PURE__ */ new Map(),
		pendingGenIds: /* @__PURE__ */ new Map(),
		completedGenerations: /* @__PURE__ */ new Map(),
		providerRequestCallIndexes: /* @__PURE__ */ new Map(),
		deferredProviderRequestCompletions: /* @__PURE__ */ new Map(),
		pendingSpans: /* @__PURE__ */ new Map(),
		completedSpanToolCallIds: /* @__PURE__ */ new Set(),
		...runId ? { runIds: /* @__PURE__ */ new Set([runId]) } : {},
		createdAt: identity.timestamp,
		timestamp: identity.timestamp
	};
	contextMap.create(key, entry);
	pendingTraceIdentities.delete(pendingKey);
	if (promptManager) {
		const promptContext = {
			agentId,
			channelId: diagnosticChannel(diagEvt),
			sessionKey
		};
		const cached = promptManager.resolveSync(agentId, promptContext);
		if (cached) entry.promptClient = cached.promptClient;
		else promptManager.resolve(agentId, promptContext).then((result) => {
			if (result) entry.promptClient = result.promptClient;
		}).catch(() => {});
	}
	return entry;
}
function isRealtimeModelCall(evt) {
	return (evt.type === "model.call.started" || evt.type === "model.call.completed" || evt.type === "model.call.error") && evt.scope !== "turn-aggregate";
}
function diagnosticNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function diagnosticUsage(evt) {
	const usage = evt.usage;
	if (!usage || typeof usage !== "object") return;
	const record = usage;
	const normalized = {};
	const inputTokens = diagnosticNumber(record.input_tokens);
	const cachedInputTokens = diagnosticNumber(record.cached_input_tokens) ?? (record.input_tokens_details && typeof record.input_tokens_details === "object" && !Array.isArray(record.input_tokens_details) ? diagnosticNumber(record.input_tokens_details.cached_tokens) : void 0);
	if (inputTokens !== void 0) normalized.input = Math.max(0, inputTokens - (cachedInputTokens ?? 0));
	else if (diagnosticNumber(record.input) !== void 0) normalized.input = diagnosticNumber(record.input) ?? 0;
	const output = diagnosticNumber(record.output) ?? diagnosticNumber(record.output_tokens);
	if (output !== void 0) normalized.output = output;
	const total = diagnosticNumber(record.total) ?? diagnosticNumber(record.totalTokens) ?? diagnosticNumber(record.total_tokens);
	if (total !== void 0) normalized.total = total;
	const cacheRead = diagnosticNumber(record.cacheRead) ?? cachedInputTokens;
	if (cacheRead !== void 0) normalized.cacheRead = cacheRead;
	const cacheWrite = diagnosticNumber(record.cacheWrite);
	if (cacheWrite !== void 0) normalized.cacheWrite = cacheWrite;
	const reasoning = diagnosticNumber(record.reasoningTokens) ?? diagnosticNumber(record.reasoning_output_tokens);
	if (reasoning !== void 0) normalized.reasoningTokens = reasoning;
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function completeProviderRequestUsage(usage) {
	const input = usage?.input;
	const output = usage?.output;
	if (typeof input !== "number" || !Number.isFinite(input) || typeof output !== "number" || !Number.isFinite(output)) return;
	const explicitTotal = usage?.totalTokens ?? usage?.total;
	const cacheRead = usage?.cacheRead;
	const cacheWrite = usage?.cacheWrite;
	const reasoningTokens = usage?.reasoningTokens;
	const normalizedCacheRead = typeof cacheRead === "number" && Number.isFinite(cacheRead) ? cacheRead : 0;
	const normalizedCacheWrite = typeof cacheWrite === "number" && Number.isFinite(cacheWrite) ? cacheWrite : 0;
	return {
		input,
		output,
		total: typeof explicitTotal === "number" && Number.isFinite(explicitTotal) ? explicitTotal : input + output + normalizedCacheRead + normalizedCacheWrite,
		...typeof cacheRead === "number" && Number.isFinite(cacheRead) ? { cacheRead } : {},
		...typeof cacheWrite === "number" && Number.isFinite(cacheWrite) ? { cacheWrite } : {},
		...typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) ? { reasoningTokens } : {}
	};
}
function updateAuthoritativeProviderUsage(entry, onBeforeSdkEnqueue) {
	const usage = completeProviderRequestUsageTotals(entry);
	if (!usage) {
		entry.authoritativeProviderUsage = void 0;
		return true;
	}
	if (!entry.finalized) {
		entry.authoritativeProviderUsage = usage;
		return true;
	}
	const nextMetadata = {
		...objectRecord$2(entry.traceMetadata),
		...runtimeMetadata(entry),
		usage: {
			inputTokens: usage.input,
			outputTokens: usage.output,
			...typeof usage.cacheRead === "number" ? { cacheReadInputTokens: usage.cacheRead } : {},
			...typeof usage.cacheWrite === "number" ? { cacheWriteInputTokens: usage.cacheWrite } : {},
			...typeof usage.reasoningTokens === "number" ? { reasoningTokens: usage.reasoningTokens } : {},
			totalTokens: usage.total
		}
	};
	if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, entry.traceId, "trace-create", "diagnostic finalized usage trace update")) return false;
	entry.authoritativeProviderUsage = usage;
	entry.traceMetadata = nextMetadata;
	entry.trace.update({ metadata: nextMetadata });
	return true;
}
function commitProviderRequestTerminal(entry, callId, usage, onBeforeSdkEnqueue) {
	const completedCallIds = entry.providerRequestCompletedCallIds ??= /* @__PURE__ */ new Set();
	const usages = entry.providerRequestUsages ??= /* @__PURE__ */ new Map();
	const previousUsage = usages.get(callId);
	completedCallIds.add(callId);
	if (usage) usages.set(callId, usage);
	if (updateAuthoritativeProviderUsage(entry, onBeforeSdkEnqueue)) return true;
	completedCallIds.delete(callId);
	if (previousUsage) usages.set(callId, previousUsage);
	else usages.delete(callId);
	return false;
}
function commitOrQueueProviderRequestTerminal(entry, callId, usage, onBeforeSdkEnqueue) {
	if (commitProviderRequestTerminal(entry, callId, usage, onBeforeSdkEnqueue)) {
		entry.providerRequestPendingTerminalCommits?.delete(callId);
		return true;
	}
	(entry.providerRequestPendingTerminalCommits ??= /* @__PURE__ */ new Map()).set(callId, usage);
	return false;
}
function retryPendingProviderRequestTerminal(entry, callId, onBeforeSdkEnqueue) {
	const pendingCommits = entry.providerRequestPendingTerminalCommits;
	if (!pendingCommits?.has(callId)) return false;
	commitOrQueueProviderRequestTerminal(entry, callId, pendingCommits.get(callId), onBeforeSdkEnqueue);
	return true;
}
function retryPendingProviderRequestTerminals(entry, onBeforeSdkEnqueue) {
	const pendingCommits = entry.providerRequestPendingTerminalCommits;
	if (!pendingCommits || pendingCommits.size === 0) return true;
	for (const [callId, usage] of pendingCommits) commitOrQueueProviderRequestTerminal(entry, callId, usage, onBeforeSdkEnqueue);
	return pendingCommits.size === 0;
}
function diagnosticModelContent(privateData) {
	return privateData?.modelContent;
}
function isCodexToolExecution(evt) {
	return (evt.toolOwner === "codex-rollout-trace" || evt.toolOwner === "codex-native-tool-lifecycle") && (evt.type === "tool.execution.started" || evt.type === "tool.execution.completed" || evt.type === "tool.execution.error" || evt.type === "tool.execution.blocked");
}
function codexToolOutputErrorCategory(toolName, output) {
	if (toolName.split(".").at(-1) !== "exec_command") return;
	const record = objectRecord$2(output);
	const exitCode = record.exit_code ?? record.exitCode;
	if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || exitCode === 0) return;
	return "codex_native_tool_nonzero_exit";
}
function codexSpawnAgentRole(toolName, input) {
	if (toolName !== "collaboration.spawn_agent") return;
	return diagnosticString(objectRecord$2(input)?.agent_type);
}
function recordCodexToolExecution(params) {
	const { entry, lineageEntry, diagEvt, privateData, redactEnabled, stateDir, agentId, sessionId, logger, onBeforeSdkEnqueue } = params;
	const toolCallId = String(diagEvt.toolCallId ?? "");
	const toolName = String(diagEvt.toolName ?? "");
	if (!toolCallId || !toolName) return;
	const rawInput = privateData?.toolContent?.toolInput;
	const spawnAgentRole = codexSpawnAgentRole(toolName, rawInput);
	if (spawnAgentRole) rememberNativeChildSpawnRole(lineageEntry, toolCallId, spawnAgentRole);
	if (entry.diagnosticCorrectedSpanToolCallIds?.has(toolCallId)) return;
	const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
	const isStart = diagEvt.type === "tool.execution.started";
	const endTime = isStart ? void 0 : eventDate(diagEvt, "endTimeMs");
	const startTime = typeof diagEvt.startTimeMs === "number" ? eventDate(diagEvt, "startTimeMs") : endTime ? new Date(Math.max(0, endTime.getTime() - durationMs)) : eventDate(diagEvt, "endTimeMs");
	const existingSpan = entry.pendingSpans.get(toolCallId) ?? entry.completedSpans?.get(toolCallId);
	const input = truncatePayload(redactObject(rawInput, redactEnabled));
	const output = truncatePayload(redactObject(privateData?.toolContent?.toolOutput, redactEnabled));
	const source = privateData?.toolContent ? "diagnostic-tool-content" : "diagnostic-tool-lifecycle";
	const spanId = generateObservationId(entry.traceId, "span", toolCallId);
	const nativeChildThreadId = diagnosticString(diagEvt.nativeChildThreadId);
	const nativeChildTurnId = diagnosticString(diagEvt.nativeChildTurnId);
	const triggeringProviderCallId = diagnosticString(diagEvt.triggeringProviderCallId);
	const providerGeneration = triggeringProviderCallId ? providerGenerationForCall(entry, triggeringProviderCallId) : void 0;
	const recordedProviderOwner = triggeringProviderCallId ? nativeChildLineage(lineageEntry).providerCallOwners.get(triggeringProviderCallId) : void 0;
	const nativeChildOwnerKey = nativeChildThreadId && nativeChildTurnId ? nativeChildTurnKey(nativeChildThreadId, nativeChildTurnId) : void 0;
	if (nativeChildOwnerKey !== void 0 && recordedProviderOwner !== void 0 && recordedProviderOwner !== nativeChildOwnerKey) noteNativeChildPartial(lineageEntry, "provider_owner_mismatch");
	const provenProviderParent = nativeChildThreadId ? recordedProviderOwner === nativeChildOwnerKey ? providerGeneration : void 0 : providerGeneration;
	const triggeringProviderGenerationIndex = triggeringProviderCallId ? entry.providerRequestGenerationIndexes?.get(triggeringProviderCallId) ?? entry.providerRequestCallIndexes?.get(triggeringProviderCallId) : void 0;
	const partialParenting = Boolean(nativeChildThreadId && entry.actorKind === "native-child" && !provenProviderParent);
	if (partialParenting) noteNativeChildPartial(lineageEntry, "partial_parenting");
	if (nativeChildThreadId && triggeringProviderCallId && !provenProviderParent) noteNativeChildPendingJoin(lineageEntry);
	const spanArgs = {
		id: spanId,
		name: `tool:${toolName}`,
		startTime,
		...input !== void 0 ? { input } : {},
		metadata: {
			toolName,
			toolCallId,
			source,
			...nativeChildDiagnosticMetadata(diagEvt),
			...partialParenting ? { partial_parenting: true } : {}
		}
	};
	if (!existingSpan) {
		if (!writeObservationEvent(stateDir, agentId, sessionId, {
			e: "span-start",
			traceId: entry.traceId,
			id: spanId,
			tool: toolName,
			toolCallId,
			ts: startTime.toISOString()
		}, logger)) {
			entry.observationLedgerIncomplete = true;
			logger?.warn?.(`Langfuse: buffered diagnostic tool observation because identity ledger append failed (traceId=${entry.traceId}, toolCallId=${toolCallId})`);
			return;
		}
	}
	const currentGeneration = nativeChildThreadId ? void 0 : resolveCurrentGeneration(entry);
	let span = existingSpan;
	if (!existingSpan) {
		if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, spanId, "span-create", "diagnostic tool span")) return;
		span = provenProviderParent ? provenProviderParent.span(spanArgs) : currentGeneration ? currentGeneration.span(spanArgs) : entry.trace.span(spanArgs);
		entry.pendingSpans.set(toolCallId, span);
		if (provenProviderParent && triggeringProviderGenerationIndex !== void 0) (entry.toolParentCallIndexes ??= /* @__PURE__ */ new Map()).set(toolCallId, triggeringProviderGenerationIndex);
		entry.toolCallCount += 1;
	}
	if (isStart) return;
	if (!span) return;
	const outputErrorCategory = codexToolOutputErrorCategory(toolName, output);
	const isError = diagEvt.type === "tool.execution.error" || diagEvt.type === "tool.execution.blocked" || outputErrorCategory !== void 0;
	const sdkFailureKey = diagnosticSdkFailureKey(spanId, "diagnostic tool span update");
	if (!entry.pendingObservationDeliveryFailures?.has(sdkFailureKey)) {
		if (!writeObservationEvent(stateDir, agentId, sessionId, {
			e: "span-end",
			traceId: entry.traceId,
			id: spanId,
			ts: (endTime ?? /* @__PURE__ */ new Date()).toISOString()
		}, logger)) {
			entry.observationLedgerIncomplete = true;
			return;
		}
	}
	if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, spanId, "span-update", "diagnostic tool span update")) return;
	span.update({
		startTime,
		...endTime ? { endTime } : {},
		...input !== void 0 ? { input } : {},
		...output !== void 0 ? { output } : {},
		metadata: {
			toolName,
			toolCallId,
			durationMs,
			source,
			...nativeChildDiagnosticMetadata(diagEvt),
			...partialParenting ? { partial_parenting: true } : {},
			...isError ? { isError: true } : {}
		},
		...isError ? {
			level: "ERROR",
			statusMessage: String(diagEvt.errorCategory ?? outputErrorCategory ?? "tool_execution_error")
		} : {}
	});
	entry.pendingSpans.delete(toolCallId);
	(entry.completedSpans ??= /* @__PURE__ */ new Map()).set(toolCallId, span);
	entry.completedSpanToolCallIds.add(toolCallId);
	(entry.diagnosticCorrectedSpanToolCallIds ??= /* @__PURE__ */ new Set()).add(toolCallId);
}
function generationInputFromModelContent(entry, callId, providerRequestIndex, diagEvt, model, modelContent, redactEnabled) {
	const requestForm = diagEvt.requestForm === "full" || diagEvt.requestForm === "ws-delta" ? diagEvt.requestForm : void 0;
	const inputMessages = Array.isArray(modelContent?.inputMessages) ? modelContent.inputMessages : modelContent?.inputMessages === void 0 ? [] : [modelContent.inputMessages];
	const cachedInput = entry.providerRequestInputs?.get(callId);
	const cachedProjection = entry.providerRequestInputProjections?.get(callId);
	if (cachedInput !== void 0 || cachedProjection) return {
		...cachedInput !== void 0 ? { generationInput: cachedInput } : {},
		projection: cachedProjection?.projection ?? "unavailable",
		requestForm: cachedProjection?.requestForm ?? requestForm
	};
	if (providerRequestIndex === 1 && typeof entry.rootInput === "string") {
		const normalized = normalizeModelCallInput({
			model,
			messages: inputMessages,
			firstGenerationInput: entry.rootInput,
			redactEnabled
		});
		return {
			...normalized.generationInput !== void 0 ? { generationInput: normalized.generationInput } : {},
			...inputMessages.length > 0 ? { nextMessages: [...inputMessages] } : {},
			projection: "first-prompt",
			requestForm
		};
	}
	if (!modelContent || modelContent.inputMessages === void 0) return {
		projection: "unavailable",
		requestForm
	};
	if (providerRequestIndex === 1) return {
		nextMessages: [...inputMessages],
		projection: "unavailable",
		requestForm
	};
	if (requestForm === "ws-delta") {
		const expectedResponseIdHash = entry.providerRequestResponseIdHashes?.get(providerRequestIndex - 1);
		if (typeof diagEvt.previousResponseIdHash !== "string" || diagEvt.previousResponseIdHash !== expectedResponseIdHash) return {
			projection: "unavailable",
			requestForm
		};
		const normalized = normalizeModelCallInput({
			model,
			messages: inputMessages,
			previousMessages: [],
			redactEnabled
		});
		return {
			...normalized.generationInput !== void 0 ? { generationInput: normalized.generationInput } : {},
			nextMessages: [...entry.previousProviderRequestInputMessages ?? [], ...inputMessages],
			projection: "ws-delta-linked",
			requestForm
		};
	}
	const normalized = normalizeModelCallInput({
		model,
		messages: inputMessages,
		previousMessages: entry.previousProviderRequestInputMessages,
		redactEnabled
	});
	if (normalized.projection === "full-request") return {
		nextMessages: normalized.nextMessages,
		projection: "unavailable",
		requestForm
	};
	return {
		...normalized.generationInput !== void 0 ? { generationInput: normalized.generationInput } : {},
		nextMessages: normalized.nextMessages,
		projection: normalized.projection,
		requestForm
	};
}
function commitProviderRequestInput(entry, callId, prepared) {
	if (prepared.nextMessages) entry.previousProviderRequestInputMessages = prepared.nextMessages;
	if (prepared.generationInput !== void 0) (entry.providerRequestInputs ??= /* @__PURE__ */ new Map()).set(callId, prepared.generationInput);
	(entry.providerRequestInputProjections ??= /* @__PURE__ */ new Map()).set(callId, {
		projection: prepared.projection,
		...prepared.requestForm ? { requestForm: prepared.requestForm } : {}
	});
}
function providerRequestProjectionMetadata(diagEvt, prepared) {
	return {
		...providerRequestIdentityMetadata(diagEvt),
		...prepared.requestForm ? { requestForm: prepared.requestForm } : {},
		inputProjection: prepared.projection,
		...typeof diagEvt.previousResponseIdHash === "string" ? { previousResponseIdHash: diagEvt.previousResponseIdHash } : {}
	};
}
function providerRequestIdentityMetadata(diagEvt) {
	const callId = diagnosticString(diagEvt.callId);
	return {
		...callId ? { providerRequestCallId: callId } : {},
		...typeof diagEvt.upstreamRequestIdHash === "string" ? { upstreamRequestIdHash: diagEvt.upstreamRequestIdHash } : {}
	};
}
function noteInputProjectionUnavailable(entry, callId) {
	const reconciliation = entry.observationReconciliation ??= {
		required: true,
		reasons: []
	};
	if (reconciliation.reasons.some((reason) => reason.reason === "input_projection_unavailable" && reason.source === `provider-request:${callId}`)) return;
	reconciliation.reasons = [...reconciliation.reasons, {
		reason: "input_projection_unavailable",
		source: `provider-request:${callId}`,
		count: 1
	}].slice(-8);
}
function generationOutputFromModelContent(modelContent, redactEnabled) {
	return modelContent?.outputMessages !== void 0 ? truncatePayload(redactObject(modelContent.outputMessages, redactEnabled)) : void 0;
}
function recordProviderRequestOutputAvailability(entry, generationIndex, output) {
	const missingOutputs = entry.providerRequestGenerationOutputMissing ??= /* @__PURE__ */ new Set();
	if (output === void 0) {
		missingOutputs.add(generationIndex);
		return;
	}
	missingOutputs.delete(generationIndex);
}
function eventDate(evt, timeField = "endTimeMs") {
	const explicitTime = evt[timeField];
	if (typeof explicitTime === "number") return new Date(explicitTime);
	if (typeof evt.sourceTimestampMs === "number") return new Date(evt.sourceTimestampMs);
	return typeof evt.ts === "number" ? new Date(evt.ts) : /* @__PURE__ */ new Date();
}
function diagnosticSourceOrder(evt) {
	for (const key of [
		"providerRequestIndex",
		"sourceOrder",
		"rolloutSourceOrder",
		"sourceIndex"
	]) {
		const value = evt[key];
		if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
		if (typeof value === "string" && /^[0-9]+$/.test(value)) {
			const parsed = Number(value);
			if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
		}
	}
}
function claimProviderRequestIndex(entry, callId, diagEvt) {
	if (!entry.providerRequestCallIndexes) entry.providerRequestCallIndexes = /* @__PURE__ */ new Map();
	const existingIndex = entry.providerRequestCallIndexes.get(callId);
	if (existingIndex) return existingIndex;
	const nextIndex = diagnosticSourceOrder(diagEvt) ?? entry.providerRequestCallIndexes.size + 1;
	entry.providerRequestCallCount = entry.providerRequestCallIndexes.size + 1;
	entry.providerRequestCallIndexes.set(callId, nextIndex);
	entry.llmCallCount = Math.max(entry.llmCallCount, nextIndex);
	entry.authoritativeProviderUsage = void 0;
	return nextIndex;
}
function claimExistingHookGenerationForProviderRequest(entry, callId, providerRequestIndex) {
	if (entry.hasProviderRequestGenerations || entry.llmCallCount < providerRequestIndex) return null;
	const canonicalGenId = generateObservationId(entry.traceId, "gen", providerRequestIndex);
	const completedGen = entry.completedGenerations.get(providerRequestIndex);
	const pendingGen = [...entry.pendingGenerations.entries()].find(([runId]) => entry.pendingGenIds.get(runId) === canonicalGenId)?.[1];
	const existingGen = completedGen ?? pendingGen;
	if (!existingGen) return null;
	const genId = completedGen ? entry.completedGenerationIds?.get(providerRequestIndex) ?? canonicalGenId : canonicalGenId;
	entry.providerRequestAugmentedHookGenerations = true;
	(entry.providerRequestGenerationIndexes ??= /* @__PURE__ */ new Map()).set(callId, providerRequestIndex);
	entry.pendingGenerations.set(callId, existingGen);
	entry.pendingGenIds.set(callId, genId);
	entry.currentGenerationId = genId;
	return {
		generation: existingGen,
		observationId: genId
	};
}
function removePendingGenerationAliases(entry, generation, genId) {
	for (const [pendingKey, pendingGeneration] of entry.pendingGenerations) if (pendingGeneration === generation || entry.pendingGenIds.get(pendingKey) === genId) {
		entry.pendingGenerations.delete(pendingKey);
		entry.pendingGenIds.delete(pendingKey);
	}
}
function isHookOrJsonlOwnedTrace(entry) {
	return entry.llmCallCount > 0 && !entry.hasProviderRequestGenerations;
}
function hasOwnedGenerationSlot(entry, providerRequestIndex) {
	const genId = generateObservationId(entry.traceId, "gen", providerRequestIndex);
	return entry.completedGenerations.has(providerRequestIndex) || [...entry.pendingGenIds.values()].includes(genId);
}
function claimProviderRequestGenerationIndex(entry, callId, providerRequestIndex) {
	const generationIndexes = entry.providerRequestGenerationIndexes ??= /* @__PURE__ */ new Map();
	const existingIndex = generationIndexes.get(callId);
	if (existingIndex !== void 0) return {
		index: existingIndex,
		rollback: () => void 0
	};
	const previousLlmCallCount = entry.llmCallCount;
	const previousHasProviderRequestGenerations = entry.hasProviderRequestGenerations;
	const claimedIndexes = new Set(generationIndexes.values());
	let generationIndex = providerRequestIndex;
	while (claimedIndexes.has(generationIndex) || hasOwnedGenerationSlot(entry, generationIndex)) generationIndex = Math.max(generationIndex + 1, entry.llmCallCount + 1);
	generationIndexes.set(callId, generationIndex);
	entry.llmCallCount = Math.max(entry.llmCallCount, generationIndex);
	entry.hasProviderRequestGenerations = true;
	return {
		index: generationIndex,
		rollback: () => {
			if (generationIndexes.get(callId) !== generationIndex) return;
			generationIndexes.delete(callId);
			entry.llmCallCount = previousLlmCallCount;
			entry.hasProviderRequestGenerations = previousHasProviderRequestGenerations;
		}
	};
}
function providerRequestGenerationIndex(entry, callId, providerRequestIndex) {
	return entry.providerRequestGenerationIndexes?.get(callId) ?? providerRequestIndex;
}
function objectRecord$2(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function redactAndTruncateText(text, redactEnabled) {
	return truncatePayload(redactText(text, redactEnabled));
}
function generationInputPayload(messages, redactEnabled) {
	return normalizeModelCallInput({
		messages: Array.isArray(messages) ? messages : [messages],
		previousMessages: [],
		redactEnabled
	}).generationInput;
}
function isDiagnosticOwnedTrace(entry) {
	return objectRecord$2(entry.traceMetadata).source === "diagnostic-event";
}
function usageValue(usage, key) {
	const value = usage[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function usageMatches(eventUsage, recordedUsage) {
	for (const key of ["input", "output"]) {
		const eventValue = usageValue(eventUsage, key);
		const recordedValue = usageValue(recordedUsage, key);
		if (eventValue === void 0 || recordedValue === void 0 || eventValue !== recordedValue) return false;
	}
	const eventTotal = usageValue(eventUsage, "total") ?? usageValue(eventUsage, "totalTokens");
	const recordedTotal = usageValue(recordedUsage, "total") ?? usageValue(recordedUsage, "totalTokens");
	if (eventTotal === void 0 || recordedTotal === void 0 || eventTotal !== recordedTotal) return false;
	for (const key of ["cacheRead", "cacheWrite"]) {
		const eventValue = usageValue(eventUsage, key);
		const recordedValue = usageValue(recordedUsage, key);
		if (eventValue !== void 0 && recordedValue !== void 0 && eventValue !== recordedValue) return false;
	}
	return true;
}
function recordedUsagesForEntry(entry) {
	return [
		entry.storedUsage,
		entry.finalizedUsage,
		entry.authoritativeProviderUsage,
		...entry.providerRequestUsages?.values() ?? []
	].filter((usage) => usage !== void 0).map((usage) => objectRecord$2(usage));
}
function entryHasRecordedUsageMatch(entry, diagEvt) {
	return [diagEvt.usage, diagEvt.lastCallUsage].filter((usage) => usage !== void 0).map((usage) => objectRecord$2(usage)).some((eventUsage) => recordedUsagesForEntry(entry).some((usage) => usageMatches(eventUsage, usage)));
}
function isLateAggregateForFinalizedHook(entry, diagEvt) {
	if (!entry?.finalized || isDiagnosticOwnedTrace(entry)) return false;
	if (!entryHasRecordedUsageMatch(entry, diagEvt)) return false;
	const provider = diagnosticString(diagEvt.provider);
	const model = diagnosticString(diagEvt.model);
	const eventModel = model ? qualifiedModel(provider, model) : void 0;
	const entryModel = entry.lastModel ? qualifiedModel(entry.lastProvider ?? provider, entry.lastModel) : void 0;
	return (!provider || !entry.lastProvider || provider === entry.lastProvider) && (!eventModel || !entryModel || eventModel === entryModel);
}
function updateProviderRequestTraceStats(entry, diagEvt, sessionKey, agentId, onBeforeSdkEnqueue) {
	const existingMetadata = objectRecord$2(entry.traceMetadata);
	const existingStats = objectRecord$2(existingMetadata.stats);
	const nextMetadata = {
		...existingMetadata,
		...runtimeMetadata(entry),
		sessionKey,
		agentId,
		channelId: diagEvt.channel,
		stats: {
			...existingStats,
			llmCallCount: entry.llmCallCount,
			toolCallCount: entry.toolCallCount
		},
		lastModel: {
			provider: String(diagEvt.provider ?? ""),
			model: String(diagEvt.model ?? "")
		}
	};
	entry.traceMetadata = nextMetadata;
	if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, entry.traceId, "trace-create", "diagnostic provider-request trace stats")) return false;
	entry.trace.update({ metadata: nextMetadata });
	return true;
}
function publishModelContextMetadata(entry, onBeforeSdkEnqueue) {
	if (entry.modelContextMetadataPublished || !entry.modelContextMetadata || Object.keys(entry.modelContextMetadata).length === 0) return true;
	if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, entry.traceId, "trace-create", "diagnostic model context trace update")) return false;
	entry.modelContextMetadataPublished = true;
	entry.trace.update({ metadata: {
		...objectRecord$2(entry.traceMetadata),
		...runtimeMetadata(entry)
	} });
	return true;
}
async function finalizeDiagnosticTraceEntry(entry, onTraceFinalized, agentId, sessionId) {
	if (!isDiagnosticOwnedTrace(entry) || entry.deliveryFinalized || entry.finalizationInProgress) return;
	entry.finalized = true;
	await onTraceFinalized?.(entry, agentId ?? "unknown", sessionId ?? "");
}
function deferProviderRequestCompletion(entry, providerRequestIndex, diagEvt, input, modelContent, privateData, redactEnabled) {
	if (!entry.deferredProviderRequestCompletions) entry.deferredProviderRequestCompletions = /* @__PURE__ */ new Map();
	const usage = diagnosticUsage(diagEvt);
	const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
	const endTime = eventDate(diagEvt, "endTimeMs");
	const explicitStartTime = typeof diagEvt.startTimeMs === "number" ? eventDate(diagEvt, "startTimeMs") : void 0;
	const usageDetails = usageDetailsFromUsage(usage);
	const output = generationOutputFromModelContent(modelContent, redactEnabled);
	recordProviderRequestOutputAvailability(entry, providerRequestIndex, output);
	const baseMetadata = {
		durationMs,
		...diagnosticRuntimeMetadata(diagEvt),
		scope: diagEvt.scope,
		usageSource: diagEvt.usageSource,
		...providerRequestIdentityMetadata(diagEvt),
		requestPayloadBytes: diagEvt.requestPayloadBytes,
		responseStreamBytes: diagEvt.responseStreamBytes,
		timeToFirstByteMs: diagEvt.timeToFirstByteMs,
		...nativeChildDiagnosticMetadata(diagEvt)
	};
	entry.deferredProviderRequestCompletions.set(providerRequestIndex, {
		endTime,
		startTime: explicitStartTime ?? (durationMs > 0 ? new Date(endTime.getTime() - durationMs) : void 0),
		...input !== void 0 ? { input } : {},
		...output !== void 0 ? { output } : {},
		...usageDetails ? { usageDetails } : {},
		...diagEvt.type === "model.call.error" ? {
			level: "ERROR",
			statusMessage: redactText(privateData?.errorMessage ?? String(diagEvt.errorCategory ?? "model_call_error"), redactEnabled),
			metadata: {
				...baseMetadata,
				errorCategory: diagEvt.errorCategory,
				failureKind: diagEvt.failureKind
			}
		} : { metadata: baseMetadata }
	});
}
/**
* Subscribe to diagnostic events for gateway mode tracing.
* Gateway auto-reply does not fire llm_input/llm_output/agent_end hooks,
* but it does emit model.usage diagnostic events after each LLM call.
* Returns an unsubscribe function, or null if diagnostic runtime events are unavailable.
*/
async function subscribeDiagnosticEvents(opts) {
	const { langfuse, contextMap, logger, stateDir, redactEnabled, config, promptManager, internalDiagnostics, onBeforeSdkEnqueue, onTraceFinalized, onNativeChildDiagnostic, onNativeChildDiagnosticBatchComplete, onNativeChildPostFinalization, resolveNativeChildParent } = opts;
	if (config.tracing?.enabled === false) return null;
	if (!internalDiagnostics) {
		logger?.warn?.("Langfuse: gateway model/tool diagnostics are unavailable; set plugins.entries.openclaw-langfuse.hooks.allowConversationAccess=true to authorize them");
		return null;
	}
	const pendingTraceIdentities = /* @__PURE__ */ new Map();
	const nativeChildDiagnosticDepth = /* @__PURE__ */ new WeakMap();
	function publishNativeChildExecutionContext(lineageEntry, childThreadId, childTurnId, diagEvt) {
		const promptStats = diagEvt.promptStats;
		if (!promptStats || typeof promptStats !== "object" || Array.isArray(promptStats)) {
			noteNativeChildPartial(lineageEntry, "child_context_unavailable");
			return;
		}
		const boundedPromptStats = Object.fromEntries(Object.entries(promptStats).filter(([, value]) => typeof value === "number" || typeof value === "string"));
		if (Object.keys(boundedPromptStats).length === 0) {
			noteNativeChildPartial(lineageEntry, "child_context_unavailable");
			return;
		}
		const observation = findNativeChildObservation(lineageEntry, childThreadId, childTurnId);
		if (!observation) {
			noteNativeChildPartial(lineageEntry, "child_observation_unavailable");
			return;
		}
		const callId = diagnosticString(diagEvt.callId);
		if (!callId) {
			noteNativeChildPartial(lineageEntry, "child_context_unavailable");
			return;
		}
		const callIds = observation.executionContextCallIds ??= /* @__PURE__ */ new Set();
		if (callIds.has(callId)) return;
		const previousLatestSummary = observation.latestExecutionContextSummary;
		const requestSummary = {
			source: "codex-rollout-request",
			...typeof diagEvt.provider === "string" ? { provider: diagEvt.provider } : {},
			...typeof diagEvt.model === "string" ? { model: diagEvt.model } : {},
			promptStats: boundedPromptStats
		};
		callIds.add(callId);
		observation.firstExecutionContextSummary ??= requestSummary;
		observation.latestExecutionContextSummary = requestSummary;
		if (typeof diagEvt.model === "string") observation.model = diagEvt.model;
		const summary = {
			source: "codex-rollout-request",
			requestCount: callIds.size,
			firstRequest: observation.firstExecutionContextSummary,
			latestRequest: observation.latestExecutionContextSummary
		};
		const childEntry = observation.traceEntry;
		if (!prepareDiagnosticSdkEnqueue(childEntry, onBeforeSdkEnqueue, childEntry.traceId, "trace-create", "child execution context")) {
			callIds.delete(callId);
			if (callIds.size === 0) {
				observation.firstExecutionContextSummary = void 0;
				observation.latestExecutionContextSummary = void 0;
			} else observation.latestExecutionContextSummary = previousLatestSummary;
			noteNativeChildPartial(lineageEntry, "child_delivery_rejected");
			return;
		}
		childEntry.traceMetadata = {
			...childEntry.traceMetadata,
			executionContextSummary: summary
		};
		childEntry.trace.update({
			input: summary,
			metadata: childEntry.traceMetadata
		});
	}
	function publishNativeChildTraceOutput(lineageEntry, observation, output) {
		if (!observation) return;
		const childEntry = observation.traceEntry;
		if (!prepareDiagnosticSdkEnqueue(childEntry, onBeforeSdkEnqueue, childEntry.traceId, "trace-create", "child generation output")) {
			noteNativeChildPartial(lineageEntry, "child_delivery_rejected");
			return;
		}
		childEntry.trace.update({ output });
		observation.traceOutputPublished = true;
	}
	async function drainPendingNativeChildDiagnostics(entry, childThreadId, childTurnId) {
		const pending = entry.pendingNativeChildDiagnostics;
		if (!pending || pending.length === 0) return;
		const ready = pending.filter((item) => item.childThreadId === childThreadId && (!childTurnId || !item.childTurnId || item.childTurnId === childTurnId));
		if (ready.length === 0) return;
		const readySet = new Set(ready);
		entry.pendingNativeChildDiagnostics = pending.filter((item) => !readySet.has(item));
		for (const item of ready) await diagnosticListener(item.event, item.metadata, item.privateData);
		clearNativeChildPending(entry, childThreadId);
	}
	function deferPendingNativeChildDiagnostic(entry, item) {
		const pending = entry.pendingNativeChildDiagnostics ??= [];
		if (pending.length >= 512) {
			const state = nativeChildLineage(entry);
			state.droppedEvents += 1;
			noteNativeChildPartial(entry, "pending_diagnostic_limit");
			return;
		}
		markNativeChildPending(entry, item.childThreadId);
		pending.push(item);
	}
	const diagnosticListener = async (evt, _metadata, privateData) => {
		let diagnosticRootEntry;
		try {
			if (!langfuse || !contextMap) return;
			const nativeChildDiagnostic = evt.type === "codex.native_child.lifecycle" || evt.type === "codex.native_child.status";
			const codexToolExecution = isCodexToolExecution(evt);
			if (evt.type !== "model.usage" && !isRealtimeModelCall(evt) && !codexToolExecution && !nativeChildDiagnostic) return;
			const diagEvt = evt;
			const modelContent = diagnosticModelContent(privateData);
			const generationOutput = generationOutputFromModelContent(modelContent, redactEnabled);
			const sessionKey = diagnosticSessionKey(diagEvt);
			const agentId = diagnosticAgentId(diagEvt, sessionKey);
			const key = TraceContextMap.key(agentId, sessionKey);
			const realtimeModelCall = isRealtimeModelCall(diagEvt);
			const realtimeModelCallId = realtimeModelCall ? diagnosticString(diagEvt.callId) ?? diagnosticString(diagEvt.runId) : void 0;
			const diagnosticRunId = diagnosticString(diagEvt.runId);
			const existingEntry = contextMap.get(key);
			const matchingRunEntry = diagnosticRunId ? contextMap.findActive(sessionKey, { runId: diagnosticRunId }) ?? contextMap.findRecent(sessionKey, { runId: diagnosticRunId }) : void 0;
			const matchingModelCallEntry = realtimeModelCallId ? contextMap.findActive(sessionKey, { runId: realtimeModelCallId }) ?? contextMap.findRecent(sessionKey, { runId: realtimeModelCallId }) : void 0;
			const activeEntry = existingEntry && !existingEntry.finalized ? existingEntry : contextMap.findActive(sessionKey);
			const lateAggregateEntry = diagEvt.type === "model.usage" ? contextMap.findRecentFinalized(sessionKey, (candidate) => isLateAggregateForFinalizedHook(candidate, diagEvt)) : void 0;
			const matchingLateAggregateEntry = !matchingRunEntry && lateAggregateEntry && (!activeEntry || recordedUsagesForEntry(activeEntry).length > 0 && !entryHasRecordedUsageMatch(activeEntry, diagEvt)) ? lateAggregateEntry : void 0;
			const reusableEntry = matchingRunEntry ?? matchingModelCallEntry ?? matchingLateAggregateEntry ?? activeEntry;
			const rootEntry = nativeChildDiagnostic && !reusableEntry ? void 0 : reusableEntry ?? (() => {
				if (existingEntry?.finalized && !realtimeModelCall) contextMap.delete(key);
				return getOrCreateDiagnosticTraceEntry({
					langfuse,
					contextMap,
					config,
					promptManager,
					diagEvt,
					sessionKey,
					agentId,
					key,
					stateDir,
					logger,
					onBeforeSdkEnqueue,
					pendingTraceIdentities
				});
			})();
			if (!rootEntry) {
				logger?.warn?.(`Langfuse: skipped diagnostic trace because the SDK delivery tracker rejected its root enqueue (agent=${agentId})`);
				return;
			}
			diagnosticRootEntry = rootEntry;
			nativeChildDiagnosticDepth.set(rootEntry, (nativeChildDiagnosticDepth.get(rootEntry) ?? 0) + 1);
			rememberRuntimeIdentity(rootEntry, {
				runtime: diagEvt.runtime,
				runtimeEngine: diagEvt.runtimeEngine,
				transport: diagEvt.transport,
				runtimeTransport: diagEvt.runtimeTransport
			});
			const nativeChildThreadId = diagnosticString(diagEvt.nativeChildThreadId ?? diagEvt.childThreadId);
			const nativeChildTurnId = diagnosticString(diagEvt.nativeChildTurnId ?? diagEvt.childTurnId);
			const admissionEntry = (nativeChildThreadId && nativeChildTurnId ? findNativeChildObservation(rootEntry, nativeChildThreadId, nativeChildTurnId) : void 0)?.traceEntry ?? rootEntry;
			const pendingDetachedChildTurn = Boolean(nativeChildDiagnostic && nativeChildThreadId && nativeChildTurnId && diagnosticString(diagEvt.triggeringToolCallId) && nativeChildLineage(rootEntry).pendingChildThreads.has(nativeChildThreadId));
			const diagnosticSequence = diagnosticNumber(diagEvt.seq);
			const acceptedByFinalizationBarrier = admissionEntry.diagnosticAdmissionClosed === true && diagnosticSequence !== void 0 && admissionEntry.finalizationDiagnosticSequence !== void 0 && diagnosticSequence <= admissionEntry.finalizationDiagnosticSequence;
			if (!pendingDetachedChildTurn && (admissionEntry.deliveryFinalized || admissionEntry.diagnosticAdmissionClosed && !acceptedByFinalizationBarrier)) {
				if (nativeChildDiagnostic) {
					noteNativeChildPostFinalization(rootEntry);
					onNativeChildPostFinalization?.(rootEntry);
				}
				return;
			}
			if (nativeChildDiagnostic) {
				onNativeChildDiagnostic?.(rootEntry, evt);
				const lifecycle = evt;
				if (lifecycle.type === "codex.native_child.lifecycle") await drainPendingNativeChildDiagnostics(rootEntry, lifecycle.childThreadId, lifecycle.childTurnId);
				return;
			}
			if (codexToolExecution) {
				let toolEntry = rootEntry;
				if (nativeChildThreadId && nativeChildTurnId && resolveNativeChildParent) {
					const nativeChildParent = resolveNativeChildParent(rootEntry, nativeChildThreadId, nativeChildTurnId, diagnosticNumber(diagEvt.startTimeMs) ?? diagnosticNumber(diagEvt.endTimeMs) ?? Date.now(), "diagnostic_tool");
					if (!nativeChildParent) {
						noteNativeChildPartial(rootEntry, "child_observation_unavailable");
						deferPendingNativeChildDiagnostic(rootEntry, {
							event: evt,
							metadata: _metadata,
							privateData,
							childThreadId: nativeChildThreadId,
							childTurnId: nativeChildTurnId
						});
						return;
					}
					toolEntry = nativeChildParent.traceEntry;
				} else if (nativeChildThreadId) {
					noteNativeChildPartial(rootEntry, "child_turn_identity_unavailable");
					return;
				}
				recordCodexToolExecution({
					entry: toolEntry,
					lineageEntry: rootEntry,
					diagEvt,
					privateData,
					redactEnabled,
					stateDir,
					agentId,
					sessionId: String(diagEvt.sessionId ?? ""),
					logger,
					onBeforeSdkEnqueue
				});
				const triggeringToolCallId = diagnosticString(diagEvt.toolCallId);
				if (triggeringToolCallId && resolveNativeChildParent) for (const [childThreadId, toolCallId] of nativeChildLineage(rootEntry).childTriggeringToolCallIds) {
					if (toolCallId !== triggeringToolCallId) continue;
					const childTurnId = nativeChildLineage(rootEntry).currentChildTurnIds.get(childThreadId);
					if (!childTurnId) continue;
					if (resolveNativeChildParent(rootEntry, childThreadId, childTurnId, diagnosticNumber(diagEvt.startTimeMs) ?? diagnosticNumber(diagEvt.endTimeMs) ?? Date.now(), "diagnostic_spawn_tool")) await drainPendingNativeChildDiagnostics(rootEntry, childThreadId, childTurnId);
				}
				return;
			}
			if (realtimeModelCall) {
				const callId = realtimeModelCallId ?? "";
				if (!callId) return;
				const nativeChildParent = nativeChildThreadId && nativeChildTurnId ? resolveNativeChildParent?.(rootEntry, nativeChildThreadId, nativeChildTurnId, diagnosticNumber(diagEvt.startTimeMs) ?? diagnosticNumber(diagEvt.endTimeMs) ?? Date.now(), "diagnostic_provider") : void 0;
				if (nativeChildThreadId && nativeChildTurnId && !rememberNativeChildProviderOwner(rootEntry, callId, nativeChildThreadId, nativeChildTurnId)) noteNativeChildPartial(rootEntry, "provider_owner_unavailable");
				if (nativeChildThreadId && !nativeChildTurnId) {
					noteNativeChildPartial(rootEntry, "child_turn_identity_unavailable");
					return;
				}
				if (nativeChildThreadId && nativeChildTurnId && !nativeChildParent) {
					noteNativeChildPartial(rootEntry, "child_observation_unavailable");
					deferPendingNativeChildDiagnostic(rootEntry, {
						event: evt,
						metadata: _metadata,
						privateData,
						childThreadId: nativeChildThreadId,
						childTurnId: nativeChildTurnId
					});
					return;
				}
				if (nativeChildThreadId && nativeChildTurnId && nativeChildParent) publishNativeChildExecutionContext(rootEntry, nativeChildThreadId, nativeChildTurnId, diagEvt);
				const entry = nativeChildParent?.traceEntry ?? rootEntry;
				const providerRequestIndex = claimProviderRequestIndex(entry, callId, diagEvt);
				if (typeof diagEvt.responseIdHash === "string") (entry.providerRequestResponseIdHashes ??= /* @__PURE__ */ new Map()).set(providerRequestIndex, diagEvt.responseIdHash);
				const terminalAlreadySeen = (entry.providerRequestCompletedCallIds ??= /* @__PURE__ */ new Set()).has(callId);
				const terminalUsage = diagEvt.type === "model.call.started" ? void 0 : completeProviderRequestUsage(diagnosticUsage(diagEvt));
				if (diagEvt.type !== "model.call.started" && entry.providerRequestPendingTerminalCommits?.has(callId)) {
					const traceStatsFailureKey = diagnosticSdkFailureKey(entry.traceId, "diagnostic provider-request trace stats");
					if (entry.pendingObservationDeliveryFailures?.has(traceStatsFailureKey) && !updateProviderRequestTraceStats(entry, diagEvt, sessionKey, agentId, onBeforeSdkEnqueue)) return;
					retryPendingProviderRequestTerminal(entry, callId, onBeforeSdkEnqueue);
					return;
				}
				if (diagEvt.type !== "model.call.started" && terminalAlreadySeen) {
					logger?.debug?.(`Langfuse: ignored duplicate provider-request terminal (agent=${agentId}, callId=${callId})`);
					return;
				}
				if (diagEvt.type === "model.call.started" && terminalAlreadySeen) {
					const preparedGenerationInput = generationInputFromModelContent(entry, callId, providerRequestIndex, diagEvt, diagnosticString(diagEvt.model), modelContent, redactEnabled);
					if (preparedGenerationInput.projection === "unavailable") noteInputProjectionUnavailable(entry, callId);
					if (!publishModelContextMetadata(entry, onBeforeSdkEnqueue)) return;
					commitProviderRequestInput(entry, callId, preparedGenerationInput);
					const generationInput = preparedGenerationInput.generationInput;
					const completedGenIndex = providerRequestGenerationIndex(entry, callId, providerRequestIndex);
					const completedGen = entry.completedGenerations.get(completedGenIndex);
					if (!completedGen) return;
					const completedGenId = entry.completedGenerationIds?.get(completedGenIndex) ?? generateObservationId(entry.traceId, "gen", completedGenIndex);
					if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, completedGenId, "generation-update", "diagnostic late provider-request start update")) return;
					completedGen.update({
						model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
						startTime: eventDate(diagEvt, "startTimeMs"),
						...generationInput !== void 0 ? { input: generationInput } : {},
						metadata: {
							provider: String(diagEvt.provider ?? ""),
							api: diagEvt.api,
							transport: diagEvt.transport,
							...diagnosticRuntimeMetadata(diagEvt),
							scope: diagEvt.scope,
							usageSource: diagEvt.usageSource,
							promptStats: diagEvt.promptStats,
							upstreamRequestIdHash: diagEvt.upstreamRequestIdHash,
							...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput),
							lateStart: true
						}
					});
					return;
				}
				const preparedGenerationInput = generationInputFromModelContent(entry, callId, providerRequestIndex, diagEvt, diagnosticString(diagEvt.model), modelContent, redactEnabled);
				if (preparedGenerationInput.projection === "unavailable") noteInputProjectionUnavailable(entry, callId);
				if (!publishModelContextMetadata(entry, onBeforeSdkEnqueue)) return;
				commitProviderRequestInput(entry, callId, preparedGenerationInput);
				const generationInput = preparedGenerationInput.generationInput;
				if (diagEvt.type === "model.call.started") {
					if (entry.pendingGenerations.has(callId)) return;
					const claimed = claimExistingHookGenerationForProviderRequest(entry, callId, providerRequestIndex);
					if (claimed) {
						if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, claimed.observationId, "generation-update", "diagnostic provider-request claimed generation update")) return;
						claimed.generation.update({
							model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
							startTime: eventDate(diagEvt, "startTimeMs"),
							...generationInput !== void 0 ? { input: generationInput } : {},
							metadata: {
								provider: String(diagEvt.provider ?? ""),
								api: diagEvt.api,
								transport: diagEvt.transport,
								...diagnosticRuntimeMetadata(diagEvt),
								scope: diagEvt.scope,
								usageSource: diagEvt.usageSource,
								promptStats: diagEvt.promptStats,
								upstreamRequestIdHash: diagEvt.upstreamRequestIdHash,
								...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput)
							}
						});
						logger?.debug?.(`Langfuse: linked provider-request diagnostic to existing hook generation (agent=${agentId}, callId=${callId})`);
						return;
					}
					const finalizedGenIndex = entry.finalized ? providerRequestIndex : void 0;
					const finalizedGen = finalizedGenIndex ? entry.completedGenerations.get(finalizedGenIndex) : void 0;
					if (isHookOrJsonlOwnedTrace(entry) && hasOwnedGenerationSlot(entry, providerRequestIndex)) {
						logger?.debug?.(`Langfuse: skipped provider-request start without matching hook generation (agent=${agentId}, callId=${callId}, index=${providerRequestIndex})`);
						return;
					}
					if (finalizedGen && finalizedGenIndex) {
						(entry.providerRequestGenerationIndexes ??= /* @__PURE__ */ new Map()).set(callId, finalizedGenIndex);
						entry.hasProviderRequestGenerations = true;
						entry.pendingGenerations.set(callId, finalizedGen);
						entry.pendingGenIds.set(callId, generateObservationId(entry.traceId, "gen", finalizedGenIndex));
						return;
					}
					const generationClaim = claimProviderRequestGenerationIndex(entry, callId, providerRequestIndex);
					if (!updateProviderRequestTraceStats(entry, diagEvt, sessionKey, agentId, onBeforeSdkEnqueue)) {
						generationClaim.rollback();
						return;
					}
					const genIndex = generationClaim.index;
					const genId = generateObservationId(entry.traceId, "gen", genIndex);
					if (!writeObservationEvent(stateDir, agentId, String(diagEvt.sessionId ?? ""), {
						e: "gen-start",
						traceId: entry.traceId,
						id: genId,
						llmCall: genIndex,
						model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
						ts: eventDate(diagEvt, "startTimeMs").toISOString()
					}, logger)) {
						entry.observationLedgerIncomplete = true;
						logger?.warn?.(`Langfuse: buffered provider-request generation because identity ledger append failed (traceId=${entry.traceId}, callId=${callId})`);
						return;
					}
					if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, genId, "generation-create", "diagnostic provider-request generation")) return;
					const gen = entry.trace.generation({
						id: genId,
						name: nativeChildGenerationName(entry, nativeChildThreadId, genIndex, callId),
						model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
						startTime: eventDate(diagEvt, "startTimeMs"),
						...generationInput !== void 0 ? { input: generationInput } : {},
						metadata: {
							provider: String(diagEvt.provider ?? ""),
							api: diagEvt.api,
							transport: diagEvt.transport,
							...diagnosticRuntimeMetadata(diagEvt),
							scope: diagEvt.scope,
							usageSource: diagEvt.usageSource,
							promptStats: diagEvt.promptStats,
							upstreamRequestIdHash: diagEvt.upstreamRequestIdHash,
							...nativeChildDiagnosticMetadata(diagEvt),
							...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput)
						},
						...entry.promptClient ? { prompt: entry.promptClient } : {}
					});
					entry.pendingGenerations.set(callId, gen);
					entry.pendingGenIds.set(callId, genId);
					if (!nativeChildThreadId) entry.currentGenerationId = genId;
					return;
				}
				let gen = entry.pendingGenerations.get(callId);
				if (!gen) {
					const claimed = claimExistingHookGenerationForProviderRequest(entry, callId, providerRequestIndex);
					if (claimed) gen = claimed.generation;
				}
				if (!gen) {
					const finalizedGenIndex = entry.finalized ? providerRequestIndex : void 0;
					const finalizedGen = finalizedGenIndex ? entry.completedGenerations.get(finalizedGenIndex) : void 0;
					const allocatedGenIndex = entry.providerRequestGenerationIndexes?.get(callId);
					const completedProviderGen = allocatedGenIndex !== void 0 ? entry.completedGenerations.get(allocatedGenIndex) : void 0;
					if (completedProviderGen && allocatedGenIndex !== void 0) {
						gen = completedProviderGen;
						entry.pendingGenIds.set(callId, generateObservationId(entry.traceId, "gen", allocatedGenIndex));
					} else if (finalizedGen && finalizedGenIndex) {
						gen = finalizedGen;
						(entry.providerRequestGenerationIndexes ??= /* @__PURE__ */ new Map()).set(callId, finalizedGenIndex);
						entry.pendingGenIds.set(callId, generateObservationId(entry.traceId, "gen", finalizedGenIndex));
					} else if (isHookOrJsonlOwnedTrace(entry) && hasOwnedGenerationSlot(entry, providerRequestIndex)) {
						deferProviderRequestCompletion(entry, providerRequestIndex, diagEvt, generationInput, modelContent, privateData, redactEnabled);
						logger?.debug?.(`Langfuse: deferred provider-request completion without matching hook generation (agent=${agentId}, callId=${callId}, index=${providerRequestIndex})`);
						commitOrQueueProviderRequestTerminal(entry, callId, terminalUsage, onBeforeSdkEnqueue);
						return;
					} else {
						const generationClaim = claimProviderRequestGenerationIndex(entry, callId, providerRequestIndex);
						if (!updateProviderRequestTraceStats(entry, diagEvt, sessionKey, agentId, onBeforeSdkEnqueue)) {
							generationClaim.rollback();
							return;
						}
					}
					const generationIndex = providerRequestGenerationIndex(entry, callId, providerRequestIndex);
					const genId = finalizedGenIndex && finalizedGen ? generateObservationId(entry.traceId, "gen", finalizedGenIndex) : generateObservationId(entry.traceId, "gen", generationIndex);
					const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
					const endTime = eventDate(diagEvt, "endTimeMs");
					const syntheticStartTime = typeof diagEvt.startTimeMs === "number" ? eventDate(diagEvt, "startTimeMs") : new Date(Math.max(0, endTime.getTime() - durationMs));
					if (!gen) {
						if (!writeObservationEvent(stateDir, agentId, String(diagEvt.sessionId ?? ""), {
							e: "gen-start",
							traceId: entry.traceId,
							id: genId,
							llmCall: generationIndex,
							model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
							ts: syntheticStartTime.toISOString()
						}, logger)) {
							entry.observationLedgerIncomplete = true;
							logger?.warn?.(`Langfuse: buffered terminal-only provider-request generation because identity ledger append failed (traceId=${entry.traceId}, callId=${callId})`);
							return;
						}
						if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, genId, "generation-create", "diagnostic terminal-only provider-request generation")) return;
						clearDiagnosticSdkFailuresForObservation(entry, genId);
						gen = entry.trace.generation({
							id: genId,
							name: nativeChildGenerationName(entry, nativeChildThreadId, generationIndex, callId),
							model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
							startTime: syntheticStartTime,
							...generationInput !== void 0 ? { input: generationInput } : {},
							metadata: {
								provider: String(diagEvt.provider ?? ""),
								api: diagEvt.api,
								transport: diagEvt.transport,
								...diagnosticRuntimeMetadata(diagEvt),
								scope: diagEvt.scope,
								orphanedStart: true,
								...nativeChildDiagnosticMetadata(diagEvt),
								...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput)
							},
							...entry.promptClient ? { prompt: entry.promptClient } : {}
						});
					}
					entry.pendingGenIds.set(callId, genId);
					if (!nativeChildThreadId) entry.currentGenerationId = genId;
				}
				const usage = diagnosticUsage(diagEvt);
				const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
				const endTime = eventDate(diagEvt, "endTimeMs");
				const startTime = typeof diagEvt.startTimeMs === "number" ? eventDate(diagEvt, "startTimeMs") : new Date(Math.max(0, endTime.getTime() - durationMs));
				const usageDetails = usageDetailsFromUsage(usage);
				const genId = entry.pendingGenIds.get(callId);
				const terminalLedgerFailureKey = `provider-request:${genId ?? callId}:gen-end`;
				if (genId) {
					if (!writeObservationEvent(stateDir, agentId, String(diagEvt.sessionId ?? ""), {
						e: "gen-end",
						traceId: entry.traceId,
						id: genId,
						ts: endTime.toISOString()
					}, logger)) {
						(entry.pendingObservationDeliveryFailures ??= /* @__PURE__ */ new Set()).add(terminalLedgerFailureKey);
						return;
					}
					entry.pendingObservationDeliveryFailures?.delete(terminalLedgerFailureKey);
				}
				if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, genId ?? entry.traceId, "generation-update", "diagnostic provider-request generation update")) return;
				if (genId) clearDiagnosticSdkFailuresForObservation(entry, genId);
				if (diagEvt.type === "model.call.error") gen.update({
					startTime,
					endTime,
					...generationInput !== void 0 ? { input: generationInput } : {},
					...generationOutput !== void 0 ? { output: generationOutput } : {},
					...usageDetails ? { usageDetails } : {},
					level: "ERROR",
					statusMessage: redactText(privateData?.errorMessage ?? String(diagEvt.errorCategory ?? "model_call_error"), redactEnabled),
					metadata: {
						durationMs,
						...diagnosticRuntimeMetadata(diagEvt),
						scope: diagEvt.scope,
						usageSource: diagEvt.usageSource,
						errorCategory: diagEvt.errorCategory,
						failureKind: diagEvt.failureKind,
						requestPayloadBytes: diagEvt.requestPayloadBytes,
						responseStreamBytes: diagEvt.responseStreamBytes,
						timeToFirstByteMs: diagEvt.timeToFirstByteMs,
						...nativeChildDiagnosticMetadata(diagEvt),
						...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput)
					}
				});
				else gen.update({
					startTime,
					endTime,
					...generationInput !== void 0 ? { input: generationInput } : {},
					...generationOutput !== void 0 ? { output: generationOutput } : {},
					...usageDetails ? { usageDetails } : {},
					metadata: {
						durationMs,
						...diagnosticRuntimeMetadata(diagEvt),
						scope: diagEvt.scope,
						usageSource: diagEvt.usageSource,
						requestPayloadBytes: diagEvt.requestPayloadBytes,
						responseStreamBytes: diagEvt.responseStreamBytes,
						timeToFirstByteMs: diagEvt.timeToFirstByteMs,
						...nativeChildDiagnosticMetadata(diagEvt),
						...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput)
					}
				});
				if (generationOutput !== void 0) publishNativeChildTraceOutput(rootEntry, nativeChildParent, generationOutput);
				const genIndex = providerRequestGenerationIndex(entry, callId, providerRequestIndex);
				recordProviderRequestOutputAvailability(entry, genIndex, generationOutput);
				entry.completedGenerations.set(genIndex, gen);
				if (genId) (entry.completedGenerationIds ??= /* @__PURE__ */ new Map()).set(genIndex, genId);
				removePendingGenerationAliases(entry, gen, genId);
				(entry.providerRequestPendingTerminalCommits ??= /* @__PURE__ */ new Map()).set(callId, terminalUsage);
				if (!updateProviderRequestTraceStats(entry, diagEvt, sessionKey, agentId, onBeforeSdkEnqueue)) return;
				retryPendingProviderRequestTerminal(entry, callId, onBeforeSdkEnqueue);
				return;
			}
			const entry = rootEntry;
			if (entry.finalized) {
				logger?.debug?.(`Langfuse: skipping diagnostic handler — agent_end already finalized (agent=${agentId})`);
				return;
			}
			const sessionId = String(diagEvt.sessionId ?? "");
			const allEntries = sessionId && sessionKey !== "unknown" ? await readSessionMessagesByIdentity({
				agentId,
				sessionId,
				sessionKey
			}, logger) : [];
			if (!entry.modelContextMetadata && allEntries.length > 0) {
				const canonicalContextMessages = allEntries.filter((candidate) => !isTranscriptOnlyAssistantMessage(candidate.message)).map((candidate) => buildApiMessage(candidate.message)).filter((message) => message.role !== "system");
				const normalizedContext = normalizeModelCallInput({
					model: diagnosticString(diagEvt.model),
					systemPrompt: entry.systemPrompt,
					messages: canonicalContextMessages,
					redactEnabled
				});
				entry.modelContextMetadata = normalizedContext.traceMetadata;
				entry.priorConversation = normalizedContext.priorConversation;
				entry.traceMetadata = {
					...objectRecord$2(entry.traceMetadata),
					...normalizedContext.traceMetadata
				};
			}
			if (entry.finalized) {
				logger?.debug?.(`Langfuse: skipping diagnostic handler — agent_end finalized during transcript read (agent=${agentId})`);
				return;
			}
			const messages = filterCurrentTurnMessages(allEntries.map((e) => e.message));
			const messagesForLlm = messages.filter((message) => !isTranscriptOnlyAssistantMessage(message));
			const turn = extractConversation(messagesForLlm);
			const diagnosticToolCallCount = countToolCallsFromMessages(messages);
			if (diagnosticToolCallCount > entry.toolCallCount) entry.toolCallCount = diagnosticToolCallCount;
			if (entry.hasProviderRequestGenerations || entry.providerRequestAugmentedHookGenerations) {
				if (!entry.finalized) {
					const existingMetadata = objectRecord$2(entry.traceMetadata);
					const existingStats = objectRecord$2(existingMetadata.stats);
					const nextMetadata = {
						...existingMetadata,
						...runtimeMetadata(entry),
						sessionKey,
						agentId,
						channelId: diagEvt.channel,
						trigger: "diagnostic",
						timestamp: entry.timestamp,
						aggregateUsage: diagEvt.usage,
						aggregateUsageSource: diagEvt.usageSource,
						stats: {
							...existingStats,
							messageCount: messages.length,
							llmCallCount: entry.llmCallCount,
							toolCallCount: entry.toolCallCount
						}
					};
					entry.traceMetadata = nextMetadata;
					if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, entry.traceId, "trace-create", "diagnostic provider-request trace update")) return;
					entry.trace.update({
						output: turn.output ? truncatePayload(redactText(turn.output, redactEnabled)) : void 0,
						metadata: nextMetadata
					});
				}
				await finalizeDiagnosticTraceEntry(entry, onTraceFinalized, agentId, String(diagEvt.sessionId ?? ""));
				logger?.info?.(`Langfuse: skipped aggregate diagnostic generation because provider-request generations exist (agent=${agentId}, model=${diagEvt.model})`);
				return;
			}
			const usage = diagEvt.usage;
			const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
			const endTime = /* @__PURE__ */ new Date();
			const startTime = new Date(endTime.getTime() - durationMs);
			const llmTurns = extractLLMTurns(messagesForLlm);
			const aggregateUsageDetails = usageDetailsFromUsage(usage);
			const aggregateDescribesSingleCall = llmTurns.length <= 1 && entry.llmCallCount <= 1 && entry.pendingGenerations.size <= 1;
			if (entry.llmCallCount > 0) {
				if (aggregateDescribesSingleCall && entry.pendingGenerations.size === 0 && entry.completedGenerations.size === 1) {
					const completedGeneration = entry.completedGenerations.entries().next().value;
					if (completedGeneration) {
						const [generationIndex, generation] = completedGeneration;
						const generationId = entry.completedGenerationIds?.get(generationIndex) ?? generateObservationId(entry.traceId, "gen", generationIndex);
						if (prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, generationId, "generation-update", "diagnostic aggregate completed generation update")) generation.update({
							...aggregateUsageDetails ? { usageDetails: aggregateUsageDetails } : {},
							metadata: { durationMs }
						});
					}
				}
				for (const [runId, gen] of entry.pendingGenerations) {
					const genId = entry.pendingGenIds.get(runId);
					if (!genId || !writeObservationEvent(stateDir, agentId, sessionId, {
						e: "gen-end",
						traceId: entry.traceId,
						id: genId,
						ts: endTime.toISOString()
					}, logger)) {
						entry.observationLedgerIncomplete = true;
						continue;
					}
					if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, genId, "generation-update", "diagnostic aggregate generation update")) continue;
					gen.update({
						endTime,
						output: turn.output ? redactAndTruncateText(turn.output, redactEnabled) : void 0,
						...aggregateDescribesSingleCall && aggregateUsageDetails ? { usageDetails: aggregateUsageDetails } : {},
						metadata: aggregateDescribesSingleCall ? { durationMs } : {}
					});
					entry.pendingGenerations.delete(runId);
					entry.pendingGenIds.delete(runId);
				}
			} else if (llmTurns.length === 0) {
				const generationIndex = entry.llmCallCount + 1;
				const genInput = generationInputPayload(turn.input, redactEnabled);
				const genOutput = turn.output ? redactAndTruncateText(turn.output, redactEnabled) : void 0;
				const genId = generateObservationId(entry.traceId, "gen", generationIndex);
				if (!writeObservationEvent(stateDir, agentId, sessionId, {
					e: "gen-start",
					traceId: entry.traceId,
					id: genId,
					llmCall: generationIndex,
					model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "unknown")),
					ts: startTime.toISOString()
				}, logger)) {
					entry.observationLedgerIncomplete = true;
					return;
				}
				if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, genId, "generation-create", "diagnostic fallback generation")) return;
				const gen = entry.trace.generation({
					id: genId,
					name: `llm-call-${generationIndex}`,
					model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "unknown")),
					startTime,
					input: genInput,
					metadata: {
						provider: String(diagEvt.provider ?? ""),
						...diagnosticRuntimeMetadata(diagEvt),
						durationMs,
						cacheRead: usage?.cacheRead,
						cacheWrite: usage?.cacheWrite,
						lastUserInput: turn.lastUserText ? redactText(turn.lastUserText, redactEnabled) : void 0
					},
					...entry.promptClient ? { prompt: entry.promptClient } : {}
				});
				entry.llmCallCount = generationIndex;
				const pendingKey = `diagnostic-fallback:${genId}`;
				entry.pendingGenerations.set(pendingKey, gen);
				entry.pendingGenIds.set(pendingKey, genId);
				if (!writeObservationEvent(stateDir, agentId, sessionId, {
					e: "gen-end",
					traceId: entry.traceId,
					id: genId,
					ts: endTime.toISOString()
				}, logger)) {
					entry.observationLedgerIncomplete = true;
					return;
				}
				if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, genId, "generation-update", "diagnostic fallback generation update")) return;
				const fallbackUsageDetails = usageDetailsFromUsage(usage);
				gen.update({
					endTime,
					output: genOutput,
					...fallbackUsageDetails ? { usageDetails: fallbackUsageDetails } : {}
				});
				entry.pendingGenerations.delete(pendingKey);
				entry.pendingGenIds.delete(pendingKey);
			} else for (let i = 0; i < llmTurns.length; i++) {
				const llmTurn = llmTurns[i];
				if (!llmTurn) continue;
				entry.llmCallCount += 1;
				const isLast = i === llmTurns.length - 1;
				const genId = generateObservationId(entry.traceId, "gen", entry.llmCallCount);
				const turnModel = qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "unknown"));
				const boundedGenInput = generationInputPayload(llmTurn.inputMessages.map((message) => buildApiMessage(message)), redactEnabled);
				const genOutput = llmTurn.assistantText ? redactAndTruncateText(llmTurn.assistantText, redactEnabled) : void 0;
				if (!writeObservationEvent(stateDir, agentId, sessionId, {
					e: "gen-start",
					traceId: entry.traceId,
					id: genId,
					llmCall: entry.llmCallCount,
					model: turnModel,
					ts: startTime.toISOString()
				}, logger)) {
					entry.observationLedgerIncomplete = true;
					continue;
				}
				if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, genId, "generation-create", "diagnostic turn generation")) continue;
				const gen = entry.trace.generation({
					id: genId,
					name: `llm-call-${entry.llmCallCount}`,
					model: turnModel,
					input: boundedGenInput,
					metadata: {
						provider: String(diagEvt.provider ?? ""),
						...diagnosticRuntimeMetadata(diagEvt),
						...llmTurn.toolCalls.length > 0 ? { toolCalls: llmTurn.toolCalls.map((t) => t.name) } : {}
					},
					...entry.promptClient ? { prompt: entry.promptClient } : {}
				});
				if (isLast) {
					if (!writeObservationEvent(stateDir, agentId, sessionId, {
						e: "gen-end",
						traceId: entry.traceId,
						id: genId,
						ts: endTime.toISOString()
					}, logger)) {
						entry.observationLedgerIncomplete = true;
						continue;
					}
					if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, genId, "generation-update", "diagnostic turn generation update")) continue;
					gen.update({
						endTime,
						output: genOutput,
						...aggregateDescribesSingleCall && aggregateUsageDetails ? { usageDetails: aggregateUsageDetails } : {},
						metadata: aggregateDescribesSingleCall ? { durationMs } : {}
					});
				} else {
					const intermediateEndTime = /* @__PURE__ */ new Date();
					if (!writeObservationEvent(stateDir, agentId, sessionId, {
						e: "gen-end",
						traceId: entry.traceId,
						id: genId,
						ts: intermediateEndTime.toISOString()
					}, logger)) {
						entry.observationLedgerIncomplete = true;
						continue;
					}
					if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, genId, "generation-update", "diagnostic turn generation end")) continue;
					gen.end({ output: genOutput });
				}
			}
			if (!entry.finalized) {
				if (!prepareDiagnosticSdkEnqueue(entry, onBeforeSdkEnqueue, entry.traceId, "trace-create", "diagnostic aggregate trace update")) return;
				const aggregateTraceMetadata = {
					...objectRecord$2(entry.traceMetadata),
					sessionKey,
					agentId,
					channelId: diagEvt.channel,
					trigger: "diagnostic",
					timestamp: entry.timestamp,
					aggregateUsage: usage,
					stats: {
						durationMs,
						messageCount: messages.length,
						llmCallCount: entry.llmCallCount,
						toolCallCount: entry.toolCallCount
					},
					...entry.lastModel ? { lastModel: {
						provider: entry.lastProvider,
						model: entry.lastModel
					} } : {},
					...entry.modelContextMetadata,
					...runtimeMetadata(entry),
					...entry.promptMatch && "name" in entry.promptMatch ? { prompt: entry.promptMatch } : {}
				};
				entry.traceMetadata = aggregateTraceMetadata;
				entry.trace.update({
					output: turn.output ? truncatePayload(redactText(turn.output, redactEnabled)) : void 0,
					metadata: aggregateTraceMetadata
				});
			}
			await finalizeDiagnosticTraceEntry(entry, onTraceFinalized, agentId, String(diagEvt.sessionId ?? ""));
			logger?.info?.(`Langfuse: generation created (agent=${agentId}, model=${diagEvt.model}, tokens=${usage?.total})`);
		} catch (err) {
			logger?.error?.(`Langfuse: diagnostic event handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		} finally {
			if (diagnosticRootEntry) {
				const depth = nativeChildDiagnosticDepth.get(diagnosticRootEntry) ?? 1;
				if (depth <= 1) {
					nativeChildDiagnosticDepth.delete(diagnosticRootEntry);
					onNativeChildDiagnosticBatchComplete?.(diagnosticRootEntry);
				} else nativeChildDiagnosticDepth.set(diagnosticRootEntry, depth - 1);
			}
		}
	};
	const unsubscribe = internalDiagnostics.onEvent((evt, metadata, privateData) => {
		const task = diagnosticListener(evt, metadata, privateData);
		opts.onDiagnosticTask?.(task, evt);
	});
	return () => {
		pendingTraceIdentities.clear();
		unsubscribe();
	};
}
//#endregion
//#region extensions/openclaw-langfuse/src/finalize.ts
function entryIndex(entries, entry, fallback) {
	const index = entries.indexOf(entry);
	return index >= 0 ? index : fallback;
}
function turnStartIndex(allEntries, turnEntries) {
	const firstTurnEntry = turnEntries[0];
	return firstTurnEntry ? entryIndex(allEntries, firstTurnEntry, 0) : 0;
}
function toolResultEntriesById(turnEntries) {
	const resultEntries = /* @__PURE__ */ new Map();
	for (const entry of turnEntries) {
		const msg = entry.message;
		if (msg.role !== "toolResult" && msg.role !== "tool") continue;
		const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : typeof msg.tool_call_id === "string" ? msg.tool_call_id : void 0;
		if (toolCallId && !resultEntries.has(toolCallId)) resultEntries.set(toolCallId, entry);
	}
	return resultEntries;
}
function toolResultOutput(msg) {
	if ("content" in msg) return msg.content;
	if ("result" in msg) return msg.result;
}
function markObservationBarrierIncomplete(entry) {
	entry.observationLedgerIncomplete = true;
}
function canonicalCostDetails(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const cost = value;
	const details = {};
	for (const key of [
		"input",
		"output",
		"total"
	]) {
		const field = cost[key];
		if (typeof field !== "number" || !Number.isFinite(field) || field < 0) continue;
		details[key] = field;
	}
	return Object.keys(details).length > 0 ? details : void 0;
}
function finalizeToolSpansFromEntries(entry, turnEntries, agentId, sessionId, redactEnabled, ctx) {
	const { logger, stateDir } = ctx;
	const resultEntries = toolResultEntriesById(turnEntries);
	for (const toolEntry of turnEntries) {
		const msg = toolEntry.message;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (!isToolCallBlock(block) || typeof block.id !== "string") continue;
			const toolCallId = block.id;
			if (entry.completedSpanToolCallIds.has(toolCallId)) continue;
			const toolName = String(block.name ?? "unknown");
			const spanId = generateObservationId(entry.traceId, "span", toolCallId);
			const input = block.input ?? block.args ?? block.arguments ?? {};
			let span = entry.pendingSpans.get(toolCallId);
			if (!span) {
				const startTime = new Date(messageTimestamp(toolEntry));
				if (!writeObservationEvent(stateDir, agentId, sessionId, {
					e: "span-start",
					traceId: entry.traceId,
					id: spanId,
					tool: toolName,
					toolCallId,
					ts: startTime.toISOString()
				}, logger) || ctx.onBeforeSdkEnqueue?.(entry, spanId, "span-create", "jsonl-finalize span") === false) {
					markObservationBarrierIncomplete(entry);
					continue;
				}
				span = entry.trace.span({
					id: spanId,
					name: `tool:${toolName}`,
					startTime,
					input: redactObject(truncatePayload(input), redactEnabled),
					metadata: {
						toolName,
						toolCallId,
						source: "jsonl-finalize"
					}
				});
				entry.pendingSpans.set(toolCallId, span);
			}
			const resultEntry = resultEntries.get(toolCallId);
			const endTime = new Date(resultEntry ? messageTimestamp(resultEntry) : messageTimestamp(toolEntry));
			const outputPayload = resultEntry ? toolResultOutput(resultEntry.message) : void 0;
			const isError = resultEntry?.message.isError === true;
			if (!writeObservationEvent(stateDir, agentId, sessionId, {
				e: "span-end",
				traceId: entry.traceId,
				id: spanId,
				ts: endTime.toISOString()
			}, logger) || ctx.onBeforeSdkEnqueue?.(entry, spanId, "span-update", "jsonl-finalize span update") === false) {
				markObservationBarrierIncomplete(entry);
				continue;
			}
			span.update({
				endTime,
				output: redactObject(truncatePayload(outputPayload), redactEnabled),
				metadata: {
					toolName,
					toolCallId,
					source: "jsonl-finalize",
					...isError ? { isError: true } : {}
				},
				...isError ? {
					level: "ERROR",
					statusMessage: "tool returned an error result"
				} : {}
			});
			entry.pendingSpans.delete(toolCallId);
			(entry.completedSpans ??= /* @__PURE__ */ new Map()).set(toolCallId, span);
			entry.completedSpanToolCallIds.add(toolCallId);
		}
	}
}
/**
* Compute corrected startTimes for each generation from JSONL timeline.
* gen-1 starts at entryTimestamp; gen-N starts after the last toolResult before it.
* This keeps the generation timeline aligned with the transcript order.
*/
function computeCorrectedStartTimes(assistantMsgs, turnEntries, entryTimestamp) {
	return assistantMsgs.map((assistantEntry, i) => {
		if (i === 0) return entryTimestamp;
		const assistantTs = assistantStartTimestamp(assistantEntry);
		let lastToolResultTs;
		for (const te of turnEntries) {
			if (messageTimestamp(te) >= assistantTs) continue;
			if (te.message.role === "toolResult") {
				const ts = messageTimestamp(te);
				if (!lastToolResultTs || ts > lastToolResultTs) lastToolResultTs = ts;
			}
		}
		const previousAssistant = assistantMsgs[i - 1];
		return lastToolResultTs ?? (previousAssistant ? assistantEndTimestamp(previousAssistant) : entryTimestamp);
	});
}
/**
* Finalize incremental observations in agentEnd.
* Completes orphan generations from the incremental path (llmInput/llmOutput)
* and keeps tool activity as generation content plus trace metadata only.
*/
function finalizeIncrementalObservations(entry, turnEntries, allEntries, agentId, sessionId, redactEnabled, ctx) {
	const { logger, stateDir } = ctx;
	const assistantMsgs = turnEntries.filter(isTraceableAssistantEntry);
	const aggregateOnlyUsageEntry = findAggregateOnlyUsageEntry(assistantMsgs, turnEntries);
	const firstTurnEntryIndex = turnStartIndex(allEntries, turnEntries);
	const orphanCompletedGenIdxs = /* @__PURE__ */ new Set();
	if (entry.pendingGenerations.size > 0) {
		logger?.debug?.(`Langfuse: agentEnd completing ${entry.pendingGenerations.size} orphan generation(s)`);
		for (const [runId, pendingGen] of entry.pendingGenerations) {
			const genId = entry.pendingGenIds.get(runId);
			const genNum = genId ? parseInt(genId.split("-gen-")[1] ?? "0", 10) : 0;
			const assistantEntry = assistantMsgs[genNum > 0 ? genNum - 1 : 0];
			const msg = assistantEntry?.message;
			const endTime = assistantEntry ? new Date(assistantEndTimestamp(assistantEntry)) : /* @__PURE__ */ new Date();
			const output = msg?.content ? buildGenerationOutput(msg.content, redactEnabled) : entry.storedOutput ? entry.storedOutput : void 0;
			const msgUsage = msg?.usage;
			const usageDetails = usageDetailsFromUsage(aggregateOnlyUsageEntry === assistantEntry ? void 0 : msgUsage);
			if (genId) {
				if (!writeObservationEvent(stateDir, agentId, sessionId, {
					e: "gen-end",
					traceId: entry.traceId,
					id: genId,
					ts: endTime.toISOString()
				}, logger) || ctx.onBeforeSdkEnqueue?.(entry, genId, "generation-update", "jsonl-finalize generation update") === false) {
					markObservationBarrierIncomplete(entry);
					continue;
				}
			}
			pendingGen.update({
				endTime,
				output: output !== void 0 && output !== null && output !== "" ? truncatePayload(output) : void 0,
				...usageDetails ? { usageDetails } : {},
				metadata: {
					provider: String(msg?.provider ?? entry.lastProvider ?? ""),
					model: msg?.model ?? entry.lastModel,
					stopReason: msg?.stopReason,
					...runtimeMetadata(entry)
				}
			});
			entry.pendingGenIds.delete(runId);
			const completedGenIdx = genNum > 0 ? genNum : entry.completedGenerations.size + 1;
			entry.completedGenerations.set(completedGenIdx, pendingGen);
			if (genId) (entry.completedGenerationIds ??= /* @__PURE__ */ new Map()).set(completedGenIdx, genId);
			orphanCompletedGenIdxs.add(completedGenIdx);
		}
		entry.pendingGenerations.clear();
	}
	const providerRequestOwnsGenerations = entry.hasProviderRequestGenerations || entry.providerRequestAugmentedHookGenerations;
	const providerSlots = new Set(entry.providerRequestGenerationIndexes?.values() ?? []);
	const exactProviderOrdinalCorrelation = providerRequestOwnsGenerations && providerSlots.size === assistantMsgs.length && assistantMsgs.length === entry.completedGenerations.size && [...providerSlots].every((slot) => slot >= 1 && slot <= assistantMsgs.length);
	const correctedStartTimes = computeCorrectedStartTimes(assistantMsgs, turnEntries, entry.timestamp);
	for (let i = 0; i < assistantMsgs.length; i++) {
		const genIdx = i + 1;
		if (providerRequestOwnsGenerations) {
			if (!exactProviderOrdinalCorrelation) continue;
			const assistantEntry = assistantMsgs[i];
			const completedGen = entry.completedGenerations.get(genIdx);
			if (!assistantEntry || !completedGen) continue;
			const costDetails = canonicalCostDetails(assistantEntry.message.usage?.cost);
			if (!costDetails) continue;
			const genId = entry.completedGenerationIds?.get(genIdx) ?? generateObservationId(entry.traceId, "gen", genIdx);
			if (ctx.onBeforeSdkEnqueue?.(entry, genId, "generation-update", "jsonl-finalize provider generation cost update") === false) {
				markObservationBarrierIncomplete(entry);
				continue;
			}
			completedGen.update({ costDetails });
			continue;
		}
		if (orphanCompletedGenIdxs.has(genIdx)) continue;
		const completedGen = entry.completedGenerations.get(genIdx);
		if (!completedGen) continue;
		const assistantEntry = assistantMsgs[i];
		if (!assistantEntry) continue;
		const msg = assistantEntry.message;
		const msgUsage = msg.usage;
		const usageForGeneration = aggregateOnlyUsageEntry === assistantEntry ? void 0 : msgUsage;
		const correctedOutput = msg.content ? truncatePayload(buildGenerationOutput(msg.content, redactEnabled)) : void 0;
		const costDetails = canonicalCostDetails(msgUsage?.cost);
		const correctedStart = correctedStartTimes[i];
		const correctedEnd = assistantEndTimestamp(assistantEntry);
		const usageDetails = usageDetailsFromUsage(usageForGeneration);
		const genId = entry.completedGenerationIds?.get(genIdx) ?? generateObservationId(entry.traceId, "gen", genIdx);
		if (ctx.onBeforeSdkEnqueue?.(entry, genId, "generation-update", "jsonl-finalize completed generation update") === false) {
			markObservationBarrierIncomplete(entry);
			continue;
		}
		completedGen.update({
			...correctedOutput !== void 0 ? { output: correctedOutput } : {},
			...correctedStart ? { startTime: new Date(correctedStart) } : {},
			endTime: new Date(correctedEnd),
			...usageDetails ? { usageDetails } : {},
			...costDetails ? { costDetails } : {},
			metadata: {
				provider: String(msg.provider ?? entry.lastProvider ?? ""),
				model: msg.model ?? entry.lastModel,
				stopReason: msg.stopReason,
				...msg.errorMessage ? { errorMessage: msg.errorMessage } : {},
				...runtimeMetadata(entry)
			},
			...msg.stopReason === "error" && msg.errorMessage ? {
				statusMessage: String(msg.errorMessage),
				level: "ERROR"
			} : {}
		});
	}
	if (!providerRequestOwnsGenerations && assistantMsgs.length > entry.llmCallCount) {
		logger?.debug?.(`Langfuse: gap fill — ${assistantMsgs.length} assistant messages but only ${entry.llmCallCount} generation(s), creating ${assistantMsgs.length - entry.llmCallCount} missing generation(s)`);
		for (let i = entry.llmCallCount; i < assistantMsgs.length; i++) {
			const genIdx = i + 1;
			entry.llmCallCount = genIdx;
			const te = assistantMsgs[i];
			if (!te) continue;
			const msg = te.message;
			const genId = generateObservationId(entry.traceId, "gen", genIdx);
			const correctedStart = correctedStartTimes[i];
			const previousAssistantEntry = i > 0 ? assistantMsgs[i - 1] : void 0;
			const startTime = correctedStart ? new Date(correctedStart) : new Date(previousAssistantEntry ? assistantEndTimestamp(previousAssistantEntry) : entry.timestamp);
			const endTime = new Date(assistantEndTimestamp(te));
			const output = buildGenerationOutput(msg.content, redactEnabled);
			const currentIdx = entryIndex(allEntries, te, allEntries.length);
			const deltaStart = previousAssistantEntry ? entryIndex(allEntries, previousAssistantEntry, firstTurnEntryIndex) : firstTurnEntryIndex;
			const deltaMessages = allEntries.slice(deltaStart, currentIdx).filter(isTraceContextInputEntry).map((e) => buildApiMessage(e.message));
			const genInput = normalizeModelCallInput({
				model: String(msg.model ?? entry.lastModel ?? "unknown"),
				messages: deltaMessages,
				previousMessages: [],
				redactEnabled
			}).generationInput;
			const msgUsage = msg.usage;
			const genUsage = usageDetailsFromUsage(aggregateOnlyUsageEntry === te ? void 0 : msgUsage);
			const gapCostDetails = canonicalCostDetails(msgUsage?.cost);
			const rawModel = String(msg.model ?? entry.lastModel ?? "unknown");
			const provider = String(msg.provider ?? entry.lastProvider ?? "");
			const model = qualifiedModel(provider, rawModel);
			const startLedgerWritten = writeObservationEvent(stateDir, agentId, sessionId, {
				e: "gen-start",
				traceId: entry.traceId,
				id: genId,
				llmCall: genIdx,
				model,
				ts: startTime.toISOString()
			}, logger);
			const endLedgerWritten = writeObservationEvent(stateDir, agentId, sessionId, {
				e: "gen-end",
				traceId: entry.traceId,
				id: genId,
				ts: endTime.toISOString()
			}, logger);
			if (!startLedgerWritten || !endLedgerWritten || ctx.onBeforeSdkEnqueue?.(entry, genId, "generation-create", "jsonl-finalize gap generation") === false) {
				markObservationBarrierIncomplete(entry);
				continue;
			}
			const generation = entry.trace.generation({
				id: genId,
				name: `llm-call-${genIdx}`,
				model,
				startTime,
				endTime,
				input: genInput,
				output: truncatePayload(output),
				usageDetails: genUsage,
				...gapCostDetails ? { costDetails: gapCostDetails } : {},
				metadata: {
					provider,
					model: msg.model,
					stopReason: msg.stopReason,
					...msg.errorMessage ? { errorMessage: msg.errorMessage } : {},
					...runtimeMetadata(entry)
				},
				...msg.stopReason === "error" && msg.errorMessage ? {
					statusMessage: String(msg.errorMessage),
					level: "ERROR"
				} : {},
				...entry.promptClient ? { prompt: entry.promptClient } : {}
			});
			entry.completedGenerations.set(genIdx, generation);
			(entry.completedGenerationIds ??= /* @__PURE__ */ new Map()).set(genIdx, genId);
			if (provider) entry.lastProvider = provider;
			if (model) entry.lastModel = model;
		}
	}
	const toolCallIds = /* @__PURE__ */ new Set();
	for (const te of turnEntries) {
		const msg = te.message;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) if (isToolCallBlock(block) && block.id) toolCallIds.add(String(block.id));
		}
	}
	if (toolCallIds.size > entry.toolCallCount) entry.toolCallCount = toolCallIds.size;
	if (!providerRequestOwnsGenerations) finalizeToolSpansFromEntries(entry, turnEntries, agentId, sessionId, redactEnabled, ctx);
}
//#endregion
//#region extensions/openclaw-langfuse/src/matcher.ts
/**
* Find the first matching rule for the given agentId.
* Rules are evaluated in array order (first match wins).
* Supports:
* - Exact match: "main" matches only "main"
* - Wildcard prefix: "openmai-*" matches any string starting with "openmai-"
* - Catch-all: "*" matches anything
*/
function findMatchingRule(agentId, rules) {
	for (const rule of rules) if (ruleMatches(agentId, rule.match)) return rule;
}
function ruleMatches(agentId, pattern) {
	if (pattern === "*") return true;
	if (pattern.endsWith("*")) {
		const prefix = pattern.slice(0, -1);
		return agentId.startsWith(prefix);
	}
	return agentId === pattern;
}
//#endregion
//#region extensions/openclaw-langfuse/src/prompt-manager.ts
var PromptManager = class {
	constructor(langfuse, config) {
		this.cache = /* @__PURE__ */ new Map();
		this.fetchTimeoutMs = 3e3;
		this.langfuse = langfuse;
		this.rules = config.prompts ?? [];
		this.cacheTtlMs = config.promptCacheTtlMs ?? 6e4;
	}
	/**
	* Pre-fetch all configured prompt rules into the cache.
	* Fire-and-forget — errors are silently ignored per rule.
	*/
	async warmCache() {
		if (!this.isCacheEnabled()) return;
		for (const rule of this.rules) try {
			const cacheKey = this.cacheKey(rule);
			if (this.cache.has(cacheKey)) continue;
			const { promptText, promptClient } = await this.fetchWithTimeout(rule);
			this.setCacheEntry(rule, promptText, promptClient);
		} catch {}
	}
	/**
	* Find matching prompt rule and fetch/compile the prompt.
	* Returns { injection, matchInfo } or undefined if no match or fetch fails.
	* Degrades gracefully: fetch errors and timeouts return undefined.
	*/
	async resolve(agentId, ctx) {
		const rule = findMatchingRule(agentId, this.rules);
		if (!rule) return;
		const cached = this.isCacheEnabled() ? this.cache.get(this.cacheKey(rule)) : void 0;
		if (cached && this.isExpired(cached)) this.refreshCache(rule);
		if (cached) {
			const compiled = this.compileTemplate(cached.compiledPrompt, ctx);
			return {
				injection: this.buildInjection(compiled, rule.inject),
				matchInfo: {
					name: rule.langfusePrompt,
					version: rule.version,
					label: rule.label,
					inject: rule.inject,
					matchRule: rule.match
				},
				promptClient: cached.promptClient
			};
		}
		try {
			const { promptText, promptClient } = await this.fetchWithTimeout(rule);
			this.setCacheEntry(rule, promptText, promptClient);
			const compiled = this.compileTemplate(promptText, ctx);
			return {
				injection: this.buildInjection(compiled, rule.inject),
				matchInfo: {
					name: rule.langfusePrompt,
					version: rule.version,
					label: rule.label,
					inject: rule.inject,
					matchRule: rule.match
				},
				promptClient
			};
		} catch {
			return;
		}
	}
	/**
	* Synchronous resolve — returns cached prompt injection if available.
	* Does NOT fetch from Langfuse. Use warmCache() or resolve() to populate cache first.
	* Used by before_prompt_build hook which must return synchronously.
	*/
	resolveSync(agentId, ctx) {
		const rule = findMatchingRule(agentId, this.rules);
		if (!rule) return;
		if (!this.isCacheEnabled()) return;
		const cacheKey = this.cacheKey(rule);
		const cached = this.cache.get(cacheKey);
		if (!cached) return;
		if (this.isExpired(cached)) this.refreshCache(rule);
		const compiled = this.compileTemplate(cached.compiledPrompt, ctx);
		return {
			injection: this.buildInjection(compiled, rule.inject),
			matchInfo: {
				name: rule.langfusePrompt,
				version: rule.version,
				label: rule.label,
				inject: rule.inject,
				matchRule: rule.match
			},
			promptClient: cached.promptClient
		};
	}
	async fetchWithTimeout(rule) {
		const promptClient = await this.langfuse.getPrompt(rule.langfusePrompt, rule.version, {
			label: rule.label,
			type: "text",
			fetchTimeoutMs: this.fetchTimeoutMs
		});
		return {
			promptText: promptClient.prompt,
			promptClient
		};
	}
	isCacheEnabled() {
		return this.cacheTtlMs > 0;
	}
	isExpired(entry) {
		return Date.now() - entry.fetchedAt >= this.cacheTtlMs;
	}
	cacheKey(rule) {
		return `${rule.langfusePrompt}:${rule.version ?? "latest"}:${rule.label ?? "default"}`;
	}
	setCacheEntry(rule, promptText, promptClient) {
		if (!this.isCacheEnabled()) return;
		this.cache.set(this.cacheKey(rule), {
			compiledPrompt: promptText,
			fetchedAt: Date.now(),
			promptName: rule.langfusePrompt,
			version: rule.version,
			label: rule.label,
			promptClient
		});
	}
	refreshCache(rule) {
		this.fetchWithTimeout(rule).then(({ promptText, promptClient }) => this.setCacheEntry(rule, promptText, promptClient)).catch(() => {});
	}
	compileTemplate(template, ctx) {
		return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
			switch (key) {
				case "agent_name": return ctx.agentId ?? "";
				case "channel_id": return ctx.channelId ?? "";
				case "session_key": return ctx.sessionKey ?? "";
				case "trigger": return ctx.trigger ?? "";
				default: return "";
			}
		});
	}
	buildInjection(prompt, inject) {
		switch (inject) {
			case "replace": return { systemPrompt: prompt };
			case "prepend": return { prependSystemContext: prompt };
			default: return { appendSystemContext: prompt };
		}
	}
};
//#endregion
//#region extensions/openclaw-langfuse/src/sdk-delivery.ts
const SDK_DELIVERY_TIMEOUT_MS = 5e3;
const SDK_DELIVERY_MAX_EVENT_BYTES = LANGFUSE_SDK_EVENT_LIMIT_BYTES;
const SDK_DELIVERY_RETIRED_TICKET_TTL_MS = SDK_DELIVERY_TIMEOUT_MS;
var SdkDeliveryTracker = class {
	constructor() {
		this.traces = /* @__PURE__ */ new Map();
		this.explicitFlushInvocation = new AsyncLocalStorage();
		this.retiredTickets = /* @__PURE__ */ new Map();
	}
	begin(traceId, observationId, eventType = "generation-create") {
		if (!this.hasPendingTrace(traceId) && this.trackedTraceCount() >= 100) return false;
		let state = this.traces.get(traceId);
		if (!state) {
			state = {
				nextSeq: 0,
				settledThrough: 0,
				tickets: []
			};
			this.traces.set(traceId, state);
		}
		const retiredTicketCount = this.retiredTickets.get(traceId)?.length ?? 0;
		if (state.tickets.length + retiredTicketCount >= 512) {
			if (state.nextSeq === 0) this.traces.delete(traceId);
			return false;
		}
		state.tickets.push({
			seq: ++state.nextSeq,
			observationId,
			eventType,
			settled: false,
			failed: false
		});
		return true;
	}
	watermark(traceId) {
		return this.traces.get(traceId)?.nextSeq ?? 0;
	}
	noteError(_payload) {}
	captureFlushScope() {
		const scope = { tickets: [] };
		for (const [traceId, state] of this.traces) for (const ticket of state.tickets) if (!ticket.settled) {
			(ticket.flushScopes ??= /* @__PURE__ */ new Set()).add(scope);
			scope.tickets.push({
				traceId,
				ticket
			});
		}
		return scope;
	}
	noteFlush(payload, error, scope = this.captureFlushScope()) {
		const flushedObservations = observationsFromSdkFlushPayload(payload);
		const observations = [];
		for (const observation of flushedObservations) observations.push({
			...observation,
			failed: error != null || observation.oversized
		});
		for (const observation of observations) {
			const traceId = observation.traceId ?? this.resolveUniqueTraceIdForObservation(scope, observation.id, observation.eventType);
			if (!traceId) continue;
			let scopedTicketIndex = -1;
			let fewestScopeReferences = Number.POSITIVE_INFINITY;
			for (let index = 0; index < scope.tickets.length; index += 1) {
				const candidate = scope.tickets[index];
				if (!candidate || candidate.traceId !== traceId || candidate.ticket.observationId !== observation.id || candidate.ticket.eventType !== observation.eventType || !this.isTicketPending(candidate, scope)) continue;
				const scopeReferences = candidate.ticket.flushScopes?.size ?? 0;
				if (scopeReferences < fewestScopeReferences) {
					scopedTicketIndex = index;
					fewestScopeReferences = scopeReferences;
				}
			}
			if (scopedTicketIndex < 0) continue;
			const scopedTicket = scope.tickets.splice(scopedTicketIndex, 1)[0];
			if (!scopedTicket) continue;
			this.settleScopedTicket(scopedTicket, scope, observation.failed);
		}
		for (const unmatchedTicket of scope.tickets) this.releaseScopedTicket(unmatchedTicket, scope);
		scope.tickets.length = 0;
		for (const state of this.traces.values()) this.advanceSettledWatermark(state);
	}
	async runExplicitFlush(invoke) {
		let complete;
		const invocation = {
			started: false,
			completion: new Promise((resolve) => {
				complete = resolve;
			}),
			complete: (result) => complete?.(result)
		};
		try {
			await this.explicitFlushInvocation.run(invocation, invoke);
		} catch {
			return {
				ok: false,
				reason: "delivery failed"
			};
		}
		if (!invocation.started) return {
			ok: false,
			reason: "delivery failed"
		};
		return await invocation.completion;
	}
	beginFlushInvocation() {
		const invocation = this.explicitFlushInvocation.getStore();
		if (!invocation || invocation.started) return;
		invocation.started = true;
		return invocation;
	}
	completeFlushInvocation(invocation, error) {
		if (!invocation) return;
		invocation.complete(error != null ? {
			ok: false,
			reason: "delivery failed"
		} : { ok: true });
	}
	async awaitTrace(traceId, watermark, timeoutMs = SDK_DELIVERY_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const result = this.traceStatus(traceId, watermark);
			if (result.done) return result.failed ? {
				ok: false,
				reason: "delivery failed"
			} : { ok: true };
			if (Date.now() >= deadline) return {
				ok: false,
				reason: "delivery timeout"
			};
			await new Promise((resolve) => {
				setTimeout(resolve, 10);
			});
		}
	}
	completeTrace(traceId, options) {
		const state = this.traces.get(traceId);
		if (!state) return;
		if (!options?.preservePending) {
			this.traces.delete(traceId);
			return;
		}
		this.advanceSettledWatermark(state);
		const pendingTickets = state.tickets.filter((ticket) => !ticket.settled && (ticket.flushScopes?.size ?? 0) > 0);
		if (pendingTickets.length > 0) {
			const retired = this.retiredTickets.get(traceId) ?? [];
			retired.push(...pendingTickets);
			this.retiredTickets.set(traceId, retired);
			setTimeout(() => {
				this.releaseRetiredTickets(traceId, pendingTickets);
			}, SDK_DELIVERY_RETIRED_TICKET_TTL_MS).unref();
		}
		this.traces.delete(traceId);
	}
	clear() {
		this.traces.clear();
		this.retiredTickets.clear();
	}
	traceStatus(traceId, watermark) {
		const state = this.traces.get(traceId);
		if (!state || watermark <= 0 || watermark > state.nextSeq) return {
			done: false,
			failed: false
		};
		return {
			done: state.settledThrough >= watermark,
			failed: state.firstFailedSeq !== void 0 && state.firstFailedSeq <= watermark
		};
	}
	advanceSettledWatermark(state) {
		while (true) {
			const nextSeq = state.settledThrough + 1;
			const ticketIndex = state.tickets.findIndex((ticket) => ticket.seq === nextSeq);
			const ticket = ticketIndex >= 0 ? state.tickets[ticketIndex] : void 0;
			if (!ticket?.settled) return;
			if (ticket.failed && state.firstFailedSeq === void 0) state.firstFailedSeq = ticket.seq;
			state.settledThrough = ticket.seq;
			state.tickets.splice(ticketIndex, 1);
		}
	}
	hasPendingTrace(traceId) {
		return (this.traces.get(traceId)?.tickets.length ?? 0) > 0 || (this.retiredTickets.get(traceId)?.length ?? 0) > 0;
	}
	trackedTraceCount() {
		const traceIds = /* @__PURE__ */ new Set();
		for (const [traceId, state] of this.traces) if (state.tickets.length > 0) traceIds.add(traceId);
		for (const [traceId, tickets] of this.retiredTickets) if (tickets.length > 0) traceIds.add(traceId);
		return traceIds.size;
	}
	resolveUniqueTraceIdForObservation(scope, observationId, eventType) {
		const traceIds = /* @__PURE__ */ new Set();
		for (const candidate of scope.tickets) if (candidate.ticket.observationId === observationId && candidate.ticket.eventType === eventType && this.isTicketPending(candidate, scope)) traceIds.add(candidate.traceId);
		return traceIds.size === 1 ? traceIds.values().next().value : void 0;
	}
	isTicketPending(candidate, scope) {
		if (!candidate.ticket.flushScopes?.has(scope)) return false;
		const activeTicket = this.traces.get(candidate.traceId)?.tickets.find((ticket) => ticket === candidate.ticket);
		if (activeTicket) return !activeTicket.settled;
		return this.retiredTickets.get(candidate.traceId)?.some((ticket) => ticket === candidate.ticket) === true;
	}
	settleScopedTicket(candidate, scope, failed) {
		if (!candidate.ticket.flushScopes?.has(scope)) return;
		candidate.ticket.flushScopes.delete(scope);
		const retiredTicketIndex = this.retiredTickets.get(candidate.traceId)?.findIndex((ticket) => ticket === candidate.ticket);
		if (retiredTicketIndex !== void 0 && retiredTicketIndex >= 0) {
			this.releaseRetiredTickets(candidate.traceId, [candidate.ticket]);
			return;
		}
		const activeTicket = this.traces.get(candidate.traceId)?.tickets.find((ticket) => ticket === candidate.ticket);
		if (!activeTicket || activeTicket.settled) return;
		activeTicket.settled = true;
		activeTicket.failed = failed;
	}
	releaseScopedTicket(candidate, scope) {
		const activeTicket = this.traces.get(candidate.traceId)?.tickets.find((ticket) => ticket === candidate.ticket);
		if (activeTicket && !activeTicket.settled) {
			activeTicket.flushScopes?.delete(scope);
			return;
		}
		const retiredTicketIndex = this.retiredTickets.get(candidate.traceId)?.findIndex((ticket) => ticket === candidate.ticket && ticket.flushScopes?.has(scope));
		if (retiredTicketIndex !== void 0 && retiredTicketIndex >= 0) {
			candidate.ticket.flushScopes?.delete(scope);
			if ((candidate.ticket.flushScopes?.size ?? 0) === 0) this.releaseRetiredTickets(candidate.traceId, [candidate.ticket]);
		}
	}
	releaseRetiredTickets(traceId, tickets) {
		const retiredTickets = this.retiredTickets.get(traceId);
		if (!retiredTickets) return;
		const releasedTickets = new Set(tickets);
		const retainedTickets = retiredTickets.filter((ticket) => !releasedTickets.has(ticket));
		if (retainedTickets.length === 0) {
			this.retiredTickets.delete(traceId);
			return;
		}
		this.retiredTickets.set(traceId, retainedTickets);
	}
};
function bindSdkDeliveryTracker(langfuse, tracker, logger, batchSize = 5) {
	const cleanups = [];
	if (typeof langfuse.flush === "function") {
		const originalFlush = langfuse.flush;
		const pendingFlushes = [];
		let automaticFlushQueued = false;
		let flushActive = false;
		let disposed = false;
		const queueAutomaticFlush = () => {
			if (automaticFlushQueued || disposed) return;
			automaticFlushQueued = true;
			pendingFlushes.push({ automatic: true });
		};
		const drainFlushQueue = () => {
			if (flushActive || disposed) return;
			const pending = pendingFlushes.shift();
			if (!pending) return;
			if (pending.automatic) automaticFlushQueued = false;
			flushActive = true;
			const scope = tracker.captureFlushScope();
			let completed = false;
			const complete = (error, items) => {
				if (completed) return;
				completed = true;
				tracker.noteFlush(items, error, scope);
				tracker.completeFlushInvocation(pending.invocation, error);
				pending.callback?.(error, items);
				const flushedItemCount = Array.isArray(items) ? items.length : 0;
				flushActive = false;
				if (flushedItemCount >= batchSize) queueAutomaticFlush();
				drainFlushQueue();
			};
			try {
				originalFlush.call(langfuse, complete);
			} catch (error) {
				complete(error, []);
			}
		};
		const trackedFlush = function(callback) {
			const invocation = tracker.beginFlushInvocation();
			if (callback || invocation) pendingFlushes.push({
				automatic: false,
				callback,
				invocation
			});
			else queueAutomaticFlush();
			drainFlushQueue();
		};
		langfuse.flush = trackedFlush;
		cleanups.push(() => {
			disposed = true;
			pendingFlushes.length = 0;
			if (langfuse.flush === trackedFlush) langfuse.flush = originalFlush;
		});
	}
	if (typeof langfuse.on === "function") cleanups.push(langfuse.on("warning", (message) => {
		logger?.warn?.(`Langfuse: [SDK-warn] ${String(message)}`);
	}), langfuse.on("error", (message) => {
		tracker.noteError(message);
		logger?.error?.(`Langfuse: [SDK-error] ${String(message)}`);
	}));
	return cleanups;
}
async function flushSdkDeliveryThroughWatermark(langfuse, tracker, traceId, watermark, timeoutMs = SDK_DELIVERY_TIMEOUT_MS) {
	if (watermark <= 0) return {
		ok: false,
		reason: "delivery timeout"
	};
	const deadline = Date.now() + timeoutMs;
	const flushResult = await flushSdkBeforeDeadline(langfuse, tracker, deadline);
	if (!flushResult.ok) return flushResult;
	return await tracker.awaitTrace(traceId, watermark, Math.max(0, deadline - Date.now()));
}
async function flushSdkDeliveryForBackpressure(langfuse, tracker, timeoutMs = SDK_DELIVERY_TIMEOUT_MS) {
	return await flushSdkBeforeDeadline(langfuse, tracker, Date.now() + timeoutMs);
}
async function flushSdkBeforeDeadline(langfuse, tracker, deadline) {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) return {
		ok: false,
		reason: "delivery timeout"
	};
	let timeout;
	try {
		return await Promise.race([tracker.runExplicitFlush(() => langfuse.flushAsync()), new Promise((resolve) => {
			timeout = setTimeout(() => resolve({
				ok: false,
				reason: "delivery timeout"
			}), remainingMs);
			timeout.unref?.();
		})]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
function observationsFromSdkFlushPayload(payload) {
	if (!Array.isArray(payload)) return [];
	const observations = [];
	for (const item of payload) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item;
		const body = objectRecord$1(record.body);
		const candidate = [
			record.observationId,
			body.id,
			body.observationId
		].find((value) => typeof value === "string" && value.length > 0);
		const type = typeof record.type === "string" ? record.type : "";
		const traceId = typeof body.traceId === "string" && body.traceId.length > 0 ? body.traceId : type.startsWith("trace-") && typeof body.id === "string" && body.id.length > 0 ? body.id : void 0;
		if (candidate && type) observations.push({
			traceId,
			id: candidate,
			eventType: type,
			oversized: serializedByteLength(item) > SDK_DELIVERY_MAX_EVENT_BYTES
		});
	}
	return observations;
}
function serializedByteLength(value) {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}
function objectRecord$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
async function recoverNativeChildTrace(lf, traceRecord, baseUrl, stateDir, logger, deliveryTracker) {
	const { traceId, agentId, sessionId } = traceRecord;
	const tracker = deliveryTracker ?? new SdkDeliveryTracker();
	const localTrackerCleanups = deliveryTracker ? [] : bindSdkDeliveryTracker(lf, tracker, logger);
	try {
		if (!tracker.begin(traceId, traceId, "trace-create")) throw new Error(`delivery ticket cap reached for child recovery trace ${traceId}`);
		lf.trace({
			id: traceId,
			name: nativeChildTraceName(agentId, "recovered"),
			sessionId: traceRecord.sessionKey ?? sessionId,
			input: {
				actorKind: "native-child",
				agentId,
				childThreadId: traceRecord.childThreadId,
				childTurnId: traceRecord.childTurnId,
				recoveryStatus: "partial"
			},
			output: {
				outcome: "partial",
				reason: "child_observation_payload_unavailable"
			},
			metadata: {
				actorKind: "native-child",
				source: "startup-recovery",
				recoveryStatus: "partial",
				recoveryReason: "child_observation_payload_unavailable",
				parentTraceId: traceRecord.parentTraceId,
				...traceRecord.parentTraceId ? { parentTraceUrl: `${baseUrl.replace(/\/+$/, "")}/trace/${traceRecord.parentTraceId}` } : {},
				spawnObservationId: traceRecord.spawnObservationId,
				childTraceId: traceId,
				childThreadId: traceRecord.childThreadId,
				childTurnId: traceRecord.childTurnId
			}
		});
		const delivery = await flushSdkDeliveryThroughWatermark(lf, tracker, traceId, tracker.watermark(traceId));
		if (!delivery.ok) throw new Error(`${delivery.reason} for child recovery trace ${traceId}`);
		if (!writeTraceMarker(stateDir, agentId, sessionId, "end", traceId, logger)) throw new Error(`failed to write child recovery end marker for trace ${traceId}`);
		return 0;
	} finally {
		tracker.completeTrace(traceId, { preservePending: true });
		for (const cleanup of localTrackerCleanups) cleanup();
	}
}
function recoveryEnv(stateDir) {
	return stateDir ? {
		...process.env,
		OPENCLAW_STATE_DIR: stateDir
	} : process.env;
}
async function readRecoverySessionMessages(stateDir, agentId, sessionId, logger) {
	const env = recoveryEnv(stateDir);
	const sessionKey = resolveTranscriptSessionKeyBySessionId({
		agentId,
		sessionId,
		env
	});
	if (sessionKey) {
		const transcriptEntries = await readSessionMessagesByIdentity({
			agentId,
			sessionId,
			sessionKey,
			env
		}, logger);
		if (transcriptEntries.length > 0) return {
			entries: transcriptEntries,
			sessionKey
		};
		logger?.debug?.(`Langfuse: transcript empty during recovery for agent=${agentId} session=${sessionId}, trying legacy JSONL fallback`);
	} else logger?.debug?.(`Langfuse: no file-backed transcript session key for agent=${agentId} session=${sessionId}, trying direct JSONL fallback`);
	return {
		entries: readSessionMessages(stateDir, agentId, sessionId, logger),
		sessionKey
	};
}
/** Lists incomplete traces from plugin-owned state without scanning session files. */
function scanIncompleteTraces(stateDir, logger) {
	const results = [];
	for (const trace of listTraceLedgerTraces(stateDir, logger)) {
		if (trace.status !== "open") continue;
		const attemptCount = trace.recoveryAttempts ?? 0;
		const abandonmentReason = trace.startedAt < Date.now() - 864e5 ? "trace_age_exceeded" : attemptCount >= 3 ? "attempt_limit_reached" : void 0;
		if (abandonmentReason) {
			writeTraceRecoveryMarker(stateDir, trace.agentId, trace.sessionId, trace.traceId, attemptCount, "abandoned", logger, abandonmentReason);
			continue;
		}
		results.push({
			traceId: trace.traceId,
			agentId: trace.agentId,
			sessionId: trace.sessionId,
			jsonlPath: path.join(stateDir, "agents", trace.agentId, "sessions", `${trace.sessionId}.jsonl`),
			...attemptCount > 0 ? { recoveryAttempts: attemptCount } : {}
		});
	}
	return results;
}
/**
* Recover a single incomplete trace by rebuilding observations from the canonical transcript.
* Writes a trace-end marker after successful recovery and flushes to Langfuse.
* Returns the number of created observations.
*/
async function recoverTrace(lf, traceInfo, config, stateDir, logger, deliveryTracker) {
	const { traceId, agentId, sessionId } = traceInfo;
	const traceRecord = readTraceLedgerTrace(stateDir, traceId, logger);
	if (!traceRecord || traceRecord.status !== "open") {
		logger?.debug?.(`Langfuse: skip recovery for trace ${traceId}; trace is not open`);
		return 0;
	}
	if (traceRecord.traceKind === "native-child") return recoverNativeChildTrace(lf, traceRecord, config.baseUrl ?? "https://cloud.langfuse.com", stateDir, logger, deliveryTracker);
	const { entries: allEntries, sessionKey } = await readRecoverySessionMessages(stateDir, agentId, sessionId, logger);
	if (allEntries.length === 0) return 0;
	const traceStartTimestamp = traceRecord.startedAt;
	const nextTraceBoundaryTimestamp = readNextTraceStartTimestamp(stateDir, traceRecord, logger);
	const traceStartIdx = allEntries.findIndex((entry) => entry.timestamp >= traceStartTimestamp);
	if (traceStartIdx < 0) return 0;
	const traceEndIdx = nextTraceBoundaryTimestamp !== void 0 ? allEntries.findIndex((entry, index) => index > traceStartIdx && entry.timestamp >= nextTraceBoundaryTimestamp) : -1;
	const turnEntries = filterCurrentTurnEntries(allEntries.slice(traceStartIdx, traceEndIdx >= 0 ? traceEndIdx : void 0));
	if (turnEntries.length === 0) return 0;
	const firstTurnEntry = turnEntries[0];
	if (!firstTurnEntry) return 0;
	const entryTimestamp = traceStartTimestamp ?? firstTurnEntry.timestamp;
	const ledger = readObservationEvents(stateDir, agentId, sessionId, traceId, logger);
	const tracker = deliveryTracker ?? new SdkDeliveryTracker();
	const localTrackerCleanups = deliveryTracker ? [] : bindSdkDeliveryTracker(lf, tracker, logger);
	const beginDelivery = async (observationId, eventType, source) => {
		if (tracker.begin(traceId, observationId, eventType)) return true;
		const watermark = tracker.watermark(traceId);
		const delivery = await flushSdkDeliveryThroughWatermark(lf, tracker, traceId, watermark);
		if (!delivery.ok) {
			logger?.warn?.(`Langfuse: ${delivery.reason} while draining SDK delivery tickets before ${source} during recovery (traceId=${traceId}, observationId=${observationId})`);
			return false;
		}
		const accepted = tracker.begin(traceId, observationId, eventType);
		if (!accepted) logger?.warn?.(`Langfuse: SDK delivery ticket cap remained exhausted before ${source} during recovery (traceId=${traceId}, observationId=${observationId})`);
		return accepted;
	};
	try {
		if (!await beginDelivery(traceId, "trace-create", "trace create")) throw new Error(`delivery ticket cap reached for recovery trace ${traceId}`);
		const trace = lf.trace({
			id: traceId,
			name: agentId,
			sessionId: sessionKey ?? sessionId,
			metadata: {
				agentId,
				sessionId,
				sessionKey,
				timestamp: entryTimestamp,
				source: "startup-recovery"
			}
		});
		const obsResult = await buildObservationsFromEntries(trace, traceId, turnEntries, allEntries, {
			entryTimestamp,
			redactEnabled: config.redactEnabled,
			generationIdsBySlot: ledger.generationIdsBySlot,
			toolSpanIdsByCallId: ledger.toolSpanIdsByCallId,
			recordObservationEvent: (event) => writeObservationEvent(stateDir, agentId, sessionId, event, logger),
			onBeforeSdkEnqueue: beginDelivery
		});
		const userEntry = turnEntries.find((e) => e.message.role === "user");
		const userInputText = userEntry ? extractUserMessageText(userEntry.message.content) : void 0;
		const hasPerCallUsage = obsResult.hasReportedUsage;
		if (!await beginDelivery(traceId, "trace-create", "trace update")) throw new Error(`delivery ticket cap reached for recovery trace update ${traceId}`);
		trace.update({
			input: userInputText ? redactText(userInputText, config.redactEnabled) : void 0,
			output: obsResult.lastAssistantText ? redactText(obsResult.lastAssistantText, config.redactEnabled) : void 0,
			metadata: {
				agentId,
				sessionId,
				sessionKey,
				timestamp: entryTimestamp,
				source: "startup-recovery",
				stats: {
					llmCallCount: obsResult.llmCallCount,
					toolCallCount: obsResult.toolCallCount
				},
				usage: hasPerCallUsage ? {
					...obsResult.reportedUsageFields.input ? { inputTokens: obsResult.totalUsage.input } : {},
					...obsResult.reportedUsageFields.output ? { outputTokens: obsResult.totalUsage.output } : {},
					...obsResult.reportedUsageFields.cacheRead ? { cacheReadInputTokens: obsResult.totalUsage.cacheRead } : {},
					...obsResult.reportedUsageFields.cacheWrite ? { cacheWriteInputTokens: obsResult.totalUsage.cacheWrite } : {},
					...obsResult.reportedUsageFields.total ? { totalTokens: obsResult.totalUsage.total } : {}
				} : void 0,
				lastModel: obsResult.lastModel || obsResult.lastProvider ? {
					provider: obsResult.lastProvider,
					model: obsResult.lastModel
				} : void 0,
				...obsResult.modelContextMetadata
			}
		});
		if (obsResult.observationBarrierIncomplete) throw new Error(`observation identity reconciliation failed for recovery trace ${traceId}`);
		const delivery = await flushSdkDeliveryThroughWatermark(lf, tracker, traceId, tracker.watermark(traceId));
		if (!delivery.ok) throw new Error(`${delivery.reason} for recovery trace ${traceId}`);
		if (!writeTraceMarker(stateDir, agentId, sessionId, "end", traceId, logger)) throw new Error(`failed to write recovery end marker for trace ${traceId}`);
		return obsResult.llmCallCount + obsResult.toolCallCount;
	} finally {
		tracker.completeTrace(traceId, { preservePending: true });
		for (const cleanup of localTrackerCleanups) cleanup();
	}
}
//#endregion
//#region extensions/openclaw-langfuse/src/service.ts
function internalDiagnosticDeliveryFromContext(ctx) {
	const diagnostics = ctx.internalDiagnostics;
	return diagnostics?.captureDeliveryCursor && diagnostics.waitForDeliveryCursor ? diagnostics : null;
}
let langfuse = null;
let contextMap = null;
let disabled = false;
let serviceLogger = null;
let serviceStateDir = null;
let unsubscribeDiagnostics = null;
let unsubscribeTranscript = null;
let sdkEventCleanups = [];
let promptManager = null;
let activeRuntimeEvents = null;
let activeServiceOwner = null;
let internalDiagnosticDelivery = null;
const inFlightRuntimeTasks = /* @__PURE__ */ new Set();
const transcriptTaskTails = /* @__PURE__ */ new Map();
const transcriptTaskPendingCounts = /* @__PURE__ */ new Map();
const transcriptTaskPendingBytes = /* @__PURE__ */ new Map();
const transcriptQueueLimitWarnedSessions = /* @__PURE__ */ new Set();
const diagnosticTaskTails = /* @__PURE__ */ new Map();
const runtimeTaskDrainWaiters = /* @__PURE__ */ new Set();
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5e3;
const BACKGROUND_TRACE_DELIVERY_TIMEOUT_MS = 3e4;
const TRANSCRIPT_TASK_MAX_PENDING_PER_SESSION = 128;
const TRANSCRIPT_TASK_MAX_PENDING_BYTES_PER_SESSION = 8 * 1024 * 1024;
const sdkDeliveryTracker = new SdkDeliveryTracker();
const PENDING_PROMPT_STATE_TTL_MS = 300 * 1e3;
const PENDING_PROMPT_STATE_MAX_ENTRIES = 256;
const pendingPromptStates = /* @__PURE__ */ new Map();
const PENDING_ROOT_TRACE_IDENTITY_TTL_MS = 300 * 1e3;
const PENDING_ROOT_TRACE_IDENTITY_MAX_ENTRIES = 256;
const pendingRootTraceIdentities = /* @__PURE__ */ new Map();
function objectRecord(value) {
	return value && typeof value === "object" ? value : {};
}
function trackRuntimeTask(task) {
	inFlightRuntimeTasks.add(task);
	const remove = () => {
		inFlightRuntimeTasks.delete(task);
		if (inFlightRuntimeTasks.size === 0) {
			for (const resolve of runtimeTaskDrainWaiters) resolve();
			runtimeTaskDrainWaiters.clear();
		}
	};
	task.then(remove, remove);
	return task;
}
async function waitForRuntimeTasksWithTimeout() {
	if (inFlightRuntimeTasks.size === 0) return true;
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (drained) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			runtimeTaskDrainWaiters.delete(onDrained);
			resolve(drained);
		};
		const onDrained = () => finish(true);
		const timeout = setTimeout(() => finish(false), SHUTDOWN_DRAIN_TIMEOUT_MS);
		runtimeTaskDrainWaiters.add(onDrained);
		if (inFlightRuntimeTasks.size === 0) onDrained();
	});
}
async function waitForDiagnosticDrainWithTimeout() {
	return await new Promise((resolve) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(false);
			}
		}, SHUTDOWN_DRAIN_TIMEOUT_MS);
		waitForDiagnosticEventsDrained().then(() => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				resolve(true);
			}
		}, () => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				resolve(false);
			}
		});
	});
}
async function waitForPromiseWithTimeout(promise, timeoutMs) {
	return await new Promise((resolve) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(false);
			}
		}, timeoutMs);
		promise.then(() => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				resolve(true);
			}
		}, () => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				resolve(false);
			}
		});
	});
}
async function waitForTranscriptTasksWithTimeout(sessionKey, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const tail = transcriptTaskTails.get(sessionKey);
		if (!tail) return true;
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0 || !await waitForPromiseWithTimeout(tail, remainingMs)) return false;
		const nextTail = transcriptTaskTails.get(sessionKey);
		if (!nextTail || nextTail === tail) return true;
	}
}
function diagnosticTaskKey(event) {
	const record = objectRecord(event);
	for (const key of [
		"sessionKey",
		"runId",
		"sessionId"
	]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "__unkeyed__";
}
/**
* The 7.1 diagnostic dispatcher invokes async listeners without awaiting them.
* Track each session's listener tail so agent_end can establish a stable
* boundary before replacing the root trace metadata.
*/
function trackDiagnosticTask(task, event) {
	const key = diagnosticTaskKey(event);
	const previous = diagnosticTaskTails.get(key);
	const settledTask = task.catch(() => void 0);
	const current = previous ? previous.catch(() => void 0).then(() => settledTask) : settledTask;
	diagnosticTaskTails.set(key, current);
	trackRuntimeTask(current);
	current.finally(() => {
		if (diagnosticTaskTails.get(key) === current) diagnosticTaskTails.delete(key);
	});
}
async function waitForDiagnosticQuiescence(identity, timeoutMs) {
	const key = diagnosticTaskKey(identity);
	const deadline = Date.now() + timeoutMs;
	let observedTail;
	while (true) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		if (!await waitForPromiseWithTimeout(waitForDiagnosticEventsDrained(), remainingMs)) return false;
		const tail = diagnosticTaskTails.get(key);
		if (tail && tail !== observedTail) {
			observedTail = tail;
			const taskRemainingMs = deadline - Date.now();
			if (taskRemainingMs <= 0 || !await waitForPromiseWithTimeout(tail, taskRemainingMs)) return false;
			continue;
		}
		const finalRemainingMs = deadline - Date.now();
		if (finalRemainingMs <= 0 || !await waitForPromiseWithTimeout(waitForDiagnosticEventsDrained(), finalRemainingMs)) return false;
		const nextTail = diagnosticTaskTails.get(key);
		if (nextTail && nextTail !== observedTail) continue;
		return true;
	}
}
async function closeTranscriptAdmissionAndDrain(entry, sessionKey, source) {
	entry.transcriptAdmissionClosed = true;
	if (!sessionKey) return true;
	const drained = await waitForTranscriptTasksWithTimeout(sessionKey, SHUTDOWN_DRAIN_TIMEOUT_MS);
	if (!drained) {
		markObservationBarrierFailed(entry, "transcript_drain_timeout", source, 1);
		serviceLogger?.warn?.(`Langfuse: timed out waiting ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms for transcript updates in ${source} (traceId=${entry.traceId})`);
	}
	return drained;
}
function estimateTranscriptUpdateBytes(update) {
	try {
		return Buffer.byteLength(JSON.stringify(update), "utf8");
	} catch {
		return 8388609;
	}
}
function enqueueTranscriptTask(sessionKey, retainedBytes, task) {
	const pendingCount = transcriptTaskPendingCounts.get(sessionKey) ?? 0;
	const pendingBytes = transcriptTaskPendingBytes.get(sessionKey) ?? 0;
	if (pendingCount >= TRANSCRIPT_TASK_MAX_PENDING_PER_SESSION || retainedBytes > TRANSCRIPT_TASK_MAX_PENDING_BYTES_PER_SESSION - pendingBytes) {
		if (!transcriptQueueLimitWarnedSessions.has(sessionKey)) {
			transcriptQueueLimitWarnedSessions.add(sessionKey);
			serviceLogger?.warn?.(`Langfuse: transcript queue limit reached for session ${sessionKey}; dropping updates until queued work drains`);
		}
		return false;
	}
	transcriptTaskPendingCounts.set(sessionKey, pendingCount + 1);
	transcriptTaskPendingBytes.set(sessionKey, pendingBytes + retainedBytes);
	const current = (transcriptTaskTails.get(sessionKey) ?? Promise.resolve()).catch(() => void 0).then(task);
	transcriptTaskTails.set(sessionKey, current);
	const remove = () => {
		const nextCount = Math.max(0, (transcriptTaskPendingCounts.get(sessionKey) ?? 1) - 1);
		const nextBytes = Math.max(0, (transcriptTaskPendingBytes.get(sessionKey) ?? retainedBytes) - retainedBytes);
		if (nextCount === 0) {
			transcriptTaskPendingCounts.delete(sessionKey);
			transcriptTaskPendingBytes.delete(sessionKey);
			transcriptQueueLimitWarnedSessions.delete(sessionKey);
		} else {
			transcriptTaskPendingCounts.set(sessionKey, nextCount);
			transcriptTaskPendingBytes.set(sessionKey, nextBytes);
		}
		if (transcriptTaskTails.get(sessionKey) === current) transcriptTaskTails.delete(sessionKey);
	};
	current.then(remove, remove);
	trackRuntimeTask(current);
	return true;
}
async function cleanupRuntimeState() {
	if (unsubscribeTranscript) {
		unsubscribeTranscript();
		unsubscribeTranscript = null;
	}
	const stopDiagnosticSubscription = unsubscribeDiagnostics;
	if (stopDiagnosticSubscription) {
		if (!await waitForDiagnosticDrainWithTimeout()) serviceLogger?.warn?.(`Langfuse: timed out waiting ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms for diagnostic events to drain during shutdown`);
		if (unsubscribeDiagnostics === stopDiagnosticSubscription) {
			stopDiagnosticSubscription();
			unsubscribeDiagnostics = null;
		}
	}
	if (!await waitForRuntimeTasksWithTimeout()) {
		serviceLogger?.warn?.(`Langfuse: timed out waiting ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms for runtime tasks to drain during shutdown`);
		inFlightRuntimeTasks.clear();
		runtimeTaskDrainWaiters.clear();
	}
	transcriptTaskTails.clear();
	diagnosticTaskTails.clear();
	transcriptTaskPendingCounts.clear();
	transcriptTaskPendingBytes.clear();
	transcriptQueueLimitWarnedSessions.clear();
	promptManager = null;
	const previousLangfuse = langfuse;
	langfuse = null;
	if (previousLangfuse) await previousLangfuse.shutdownAsync();
	for (const unsub of sdkEventCleanups) unsub();
	sdkEventCleanups = [];
	sdkDeliveryTracker.clear();
	pendingRootTraceIdentities.clear();
	if (contextMap) {
		contextMap.stopSweep();
		contextMap.clear();
		contextMap = null;
	}
	activeRuntimeEvents = null;
	internalDiagnosticDelivery = null;
}
function extractPromptInjectionState(injection) {
	if (!injection) return;
	const promptInjection = {
		prepend: typeof injection.prependSystemContext === "string" ? injection.prependSystemContext : void 0,
		append: typeof injection.appendSystemContext === "string" ? injection.appendSystemContext : void 0
	};
	return promptInjection.prepend || promptInjection.append ? promptInjection : void 0;
}
function promptStateFromResolveResult(result) {
	return {
		matchInfo: result.matchInfo,
		promptClient: result.promptClient,
		promptInjection: extractPromptInjectionState(result.injection),
		createdAt: Date.now()
	};
}
function promptInjectionLogSummary(result) {
	const injection = result.injection;
	const content = injection.systemPrompt ?? injection.prependSystemContext ?? injection.appendSystemContext ?? "";
	const mode = result.matchInfo.inject ?? (injection.systemPrompt ? "replace" : injection.prependSystemContext ? "prepend" : injection.appendSystemContext ? "append" : "unknown");
	return `name=${result.matchInfo.name} mode=${mode} length=${content.length}`;
}
function applyPromptState(entry, state) {
	if (state.matchInfo) entry.promptMatch = state.matchInfo;
	if (state.promptClient !== void 0) entry.promptClient = state.promptClient;
	if (state.promptInjection) entry.promptInjection = state.promptInjection;
}
function prunePendingPromptStates(now = Date.now()) {
	for (const [key, state] of pendingPromptStates) if (now - state.createdAt > PENDING_PROMPT_STATE_TTL_MS) pendingPromptStates.delete(key);
	while (pendingPromptStates.size > PENDING_PROMPT_STATE_MAX_ENTRIES) {
		const oldestKey = pendingPromptStates.keys().next().value;
		if (oldestKey === void 0) break;
		pendingPromptStates.delete(oldestKey);
	}
}
function prunePendingRootTraceIdentities(now = Date.now()) {
	for (const [key, identity] of pendingRootTraceIdentities) if (now - identity.createdAt > PENDING_ROOT_TRACE_IDENTITY_TTL_MS) pendingRootTraceIdentities.delete(key);
	while (pendingRootTraceIdentities.size >= PENDING_ROOT_TRACE_IDENTITY_MAX_ENTRIES) {
		const oldestKey = pendingRootTraceIdentities.keys().next().value;
		if (oldestKey === void 0) break;
		pendingRootTraceIdentities.delete(oldestKey);
	}
}
function isUserPromptMessage(message, prompt) {
	if (!message || typeof message !== "object") return false;
	const record = message;
	return record.role === "user" && extractTextContent(record.content) === prompt;
}
function buildLlmInputMessages(historyMessages, prompt) {
	if (!prompt) return [...historyMessages];
	if (isUserPromptMessage(historyMessages.at(-1), prompt)) return [...historyMessages];
	return [...historyMessages, {
		role: "user",
		content: prompt
	}];
}
function replaceTraceMetadata(entry, metadata) {
	entry.traceMetadata = metadata;
	return metadata;
}
function mergeTraceMetadata(entry, patch) {
	const metadata = {
		...entry.traceMetadata,
		...runtimeMetadata(entry),
		...patch
	};
	entry.traceMetadata = metadata;
	return metadata;
}
function metadataRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function finiteUsageNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function usageFieldPresence(usage) {
	return {
		input: finiteUsageNumber(usage?.input) !== void 0,
		output: finiteUsageNumber(usage?.output) !== void 0,
		cacheRead: finiteUsageNumber(usage?.cacheRead) !== void 0,
		cacheWrite: finiteUsageNumber(usage?.cacheWrite) !== void 0,
		total: finiteUsageNumber(usage?.total) !== void 0
	};
}
function mergeTraceStats(entry, patch) {
	return {
		...metadataRecord(entry.traceMetadata?.stats),
		...patch
	};
}
function safeToolErrorStatusMessage(error, redactEnabled) {
	if (redactEnabled) return "tool returned an error result";
	return typeof error === "string" && error.trim() ? error : "tool returned an error result";
}
function safeAgentErrorStatusMessage(error, redactEnabled) {
	if (redactEnabled) return "agent run failed";
	return typeof error === "string" && error.trim() ? error : "agent run failed";
}
function canonicalAgentEndAssistantText(messages) {
	let currentTurnStart = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message && typeof message === "object" && !Array.isArray(message) && message.role === "user") {
			currentTurnStart = index;
			break;
		}
	}
	for (let index = messages.length - 1; index > currentTurnStart; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;
		const assistant = message;
		if (assistant.role !== "assistant" || isTranscriptOnlyAssistantMessage(assistant) || Array.isArray(assistant.content) && assistant.content.some((block) => isToolCallBlock(block))) continue;
		const text = extractTextContent(assistant.content);
		if (text) return text;
	}
}
function llmInputRunIds(entry) {
	const extended = entry;
	if (!extended.llmInputRunIds) extended.llmInputRunIds = /* @__PURE__ */ new Set();
	return extended.llmInputRunIds;
}
const MAX_OBSERVATION_RECONCILIATION_REASONS = 8;
function markObservationBarrierFailed(entry, reason, source, count = 1) {
	entry.observationLedgerIncomplete = true;
	const reconciliation = entry.observationReconciliation ??= {
		required: true,
		reasons: []
	};
	reconciliation.required = true;
	const existing = reconciliation.reasons.find((candidate) => candidate.reason === reason && candidate.source === source);
	if (existing) {
		existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + count);
		return;
	}
	if (reconciliation.reasons.length < MAX_OBSERVATION_RECONCILIATION_REASONS) reconciliation.reasons.push({
		reason,
		source,
		count
	});
}
function sdkDeliveryFailureKey(observationId, source) {
	return `sdk:${source}:${observationId}`;
}
function markSdkDeliveryPending(entry, observationId, source) {
	(entry.pendingObservationDeliveryFailures ??= /* @__PURE__ */ new Set()).add(sdkDeliveryFailureKey(observationId, source));
}
function clearSdkDeliveryPending(entry, observationId, source) {
	entry.pendingObservationDeliveryFailures?.delete(sdkDeliveryFailureKey(observationId, source));
}
function clearSupersededSdkDeliveryFailures(entry, observationId) {
	const failures = entry.pendingObservationDeliveryFailures;
	if (!failures) return;
	const suffix = `:${observationId}`;
	for (const failure of failures) if (failure.startsWith("sdk:") && failure.endsWith(suffix)) failures.delete(failure);
}
function beginSdkEnqueue(entry, observationId, eventType, source) {
	if (entry.deliveryFinalized) {
		serviceLogger?.warn?.(`Langfuse: rejected ${source} enqueue after trace delivery finalized (traceId=${entry.traceId}, observationId=${observationId})`);
		return false;
	}
	if (sdkDeliveryTracker.begin(entry.traceId, observationId, eventType)) {
		clearSdkDeliveryPending(entry, observationId, source);
		return true;
	}
	markSdkDeliveryPending(entry, observationId, source);
	serviceLogger?.warn?.(`Langfuse: SDK delivery ticket cap reached before ${source} enqueue (traceId=${entry.traceId}, observationId=${observationId})`);
	return false;
}
function beginRootTraceSdkEnqueue(traceId, source) {
	if (sdkDeliveryTracker.begin(traceId, traceId, "trace-create")) return true;
	serviceLogger?.warn?.(`Langfuse: SDK delivery trace cap reached before ${source} enqueue (traceId=${traceId})`);
	return false;
}
function beginSdkReconstructionEnqueue(entry, observationId, eventType, source) {
	if (!beginSdkEnqueue(entry, observationId, eventType, source)) return false;
	clearSupersededSdkDeliveryFailures(entry, observationId);
	return true;
}
async function beginSdkEnqueueWithBackpressure(entry, observationId, eventType, source) {
	if (entry.deliveryFinalized) {
		serviceLogger?.warn?.(`Langfuse: rejected ${source} enqueue after trace delivery finalized (traceId=${entry.traceId}, observationId=${observationId})`);
		return false;
	}
	if (sdkDeliveryTracker.begin(entry.traceId, observationId, eventType)) {
		clearSdkDeliveryPending(entry, observationId, source);
		return true;
	}
	markSdkDeliveryPending(entry, observationId, source);
	const client = langfuse;
	if (!client) {
		markObservationBarrierFailed(entry, "delivery_ticket_cap", "langfuse-sdk-ticket");
		return false;
	}
	const watermark = sdkDeliveryTracker.watermark(entry.traceId);
	try {
		const delivery = watermark > 0 ? await flushSdkDeliveryThroughWatermark(client, sdkDeliveryTracker, entry.traceId, watermark) : await flushSdkDeliveryForBackpressure(client, sdkDeliveryTracker);
		if (!delivery.ok) {
			markObservationBarrierFailed(entry, "delivery_drain_failed", "langfuse-sdk-ticket");
			serviceLogger?.warn?.(`Langfuse: ${delivery.reason} while draining SDK delivery tickets before ${source} enqueue (traceId=${entry.traceId}, observationId=${observationId})`);
			return false;
		}
	} catch (err) {
		markObservationBarrierFailed(entry, "delivery_drain_failed", "langfuse-sdk-ticket");
		serviceLogger?.warn?.(`Langfuse: failed to drain SDK delivery tickets before ${source} enqueue (traceId=${entry.traceId}, observationId=${observationId}): ${String(err)}`);
		return false;
	}
	if (sdkDeliveryTracker.begin(entry.traceId, observationId, eventType)) {
		clearSdkDeliveryPending(entry, observationId, source);
		return true;
	}
	markObservationBarrierFailed(entry, "delivery_ticket_cap", "langfuse-sdk-ticket");
	serviceLogger?.warn?.(`Langfuse: SDK delivery ticket cap remained exhausted before ${source} enqueue (traceId=${entry.traceId}, observationId=${observationId})`);
	return false;
}
async function finalizeTraceDelivery(entry, agentId, sessionId, source, deliveryTimeoutMs = SDK_DELIVERY_TIMEOUT_MS) {
	const client = langfuse;
	if (!client) return false;
	if ((entry.providerRequestPendingTerminalCommits?.size ?? 0) > 0) {
		const capacityWatermark = sdkDeliveryTracker.watermark(entry.traceId);
		try {
			const capacityDelivery = capacityWatermark > 0 ? await flushSdkDeliveryThroughWatermark(client, sdkDeliveryTracker, entry.traceId, capacityWatermark, deliveryTimeoutMs) : await flushSdkDeliveryForBackpressure(client, sdkDeliveryTracker, deliveryTimeoutMs);
			if (!capacityDelivery.ok) {
				serviceLogger?.warn?.(`Langfuse: ${capacityDelivery.reason} while draining SDK capacity before pending provider usage retry in ${source} (traceId=${entry.traceId}), skipping end marker`);
				return false;
			}
		} catch (err) {
			serviceLogger?.warn?.(`Langfuse: failed to drain SDK capacity before pending provider usage retry in ${source} (traceId=${entry.traceId}): ${String(err)}`);
			return false;
		}
	}
	if (!retryPendingProviderRequestTerminals(entry, (_traceId, observationId, eventType, enqueueSource) => beginSdkEnqueue(entry, observationId, eventType, enqueueSource))) {
		serviceLogger?.warn?.(`Langfuse: pending provider usage could not be enqueued in ${source} (traceId=${entry.traceId}), skipping end marker`);
		return false;
	}
	const deliveryWatermark = sdkDeliveryTracker.watermark(entry.traceId);
	try {
		const delivery = await flushSdkDeliveryThroughWatermark(client, sdkDeliveryTracker, entry.traceId, deliveryWatermark, deliveryTimeoutMs);
		if (!delivery.ok) {
			serviceLogger?.warn?.(`Langfuse: ${delivery.reason} in ${source} (traceId=${entry.traceId}), skipping end marker`);
			return false;
		}
		if (entry.observationLedgerIncomplete || (entry.pendingObservationDeliveryFailures?.size ?? 0) > 0) {
			serviceLogger?.warn?.(`Langfuse: observation ledger/reconciliation incomplete in ${source} (traceId=${entry.traceId}), skipping end marker`);
			return false;
		}
		if (!writeTraceMarker(serviceStateDir, agentId, sessionId, "end", entry.traceId, serviceLogger)) {
			markObservationBarrierFailed(entry, "trace_end_marker_failed", source);
			return false;
		}
		entry.deliveryFinalized = true;
		return true;
	} catch (flushErr) {
		serviceLogger?.warn?.(`Langfuse: flushAsync failed in ${source} (traceId=${entry.traceId}), skipping end marker — ${String(flushErr)}`);
		return false;
	}
}
function completeTraceFinalization(entry) {
	sdkDeliveryTracker.completeTrace(entry.traceId, { preservePending: !entry.deliveryFinalized });
	entry.finalizationInProgress = false;
	entry.finalizationDiagnosticSequence = void 0;
}
async function finalizeTraceDeliveryWithinReplyBudget(entry, agentId, sessionId, source) {
	const deliveryTask = (async () => {
		if (await finalizeTraceDelivery(entry, agentId, sessionId, source, BACKGROUND_TRACE_DELIVERY_TIMEOUT_MS)) return true;
		serviceLogger?.warn?.(`Langfuse: retrying final delivery once in ${source} (traceId=${entry.traceId})`);
		return await finalizeTraceDelivery(entry, agentId, sessionId, `${source}-retry`, BACKGROUND_TRACE_DELIVERY_TIMEOUT_MS);
	})();
	if (await waitForPromiseWithTimeout(deliveryTask, SHUTDOWN_DRAIN_TIMEOUT_MS)) return false;
	serviceLogger?.warn?.(`Langfuse: delivery exceeded ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms in ${source}; continuing in background (traceId=${entry.traceId})`);
	trackRuntimeTask(deliveryTask.catch((error) => {
		serviceLogger?.warn?.(`Langfuse: background delivery failed in ${source} (traceId=${entry.traceId}) — ${String(error)}`);
		return false;
	}).finally(() => completeTraceFinalization(entry)));
	return true;
}
function appendObservationEventOrMark(entry, agentId, sessionId, event, source) {
	const written = writeObservationEvent(serviceStateDir, agentId, sessionId, event, serviceLogger);
	if (!written) {
		markObservationBarrierFailed(entry, "identity_ledger_append_failed", source);
		serviceLogger?.warn?.(`Langfuse: buffered observation because identity ledger append failed (traceId=${entry.traceId}, observationId=${event.id})`);
	}
	return written;
}
/**
* Creates the Langfuse plugin service with full tracing and prompt management.
*/
function createLangfuseService(config, logger, pluginRuntime) {
	serviceLogger = logger ?? null;
	const serviceOwner = Symbol("openclaw-langfuse-service");
	let ownsActiveRuntime = false;
	const transientMessageMetadata = /* @__PURE__ */ new WeakMap();
	let lastRootTraceTimestamp = 0;
	const redactEnabled = config.tracing?.redact !== false;
	const tracingEnabled = config.tracing?.enabled !== false;
	const langfuseTraceBaseUrl = resolveCredentials(config).baseUrl.replace(/\/+$/, "");
	function getEntry(agentId, sessionKey) {
		return contextMap?.get(TraceContextMap.key(agentId, sessionKey));
	}
	function nativeChildLedgerIdentity(entry, hints) {
		const metadata = entry.traceMetadata ?? {};
		return {
			agentId: hints?.agentId ?? (typeof metadata.agentId === "string" ? metadata.agentId : "unknown"),
			sessionId: hints?.sessionId ?? entry.sessionId ?? (typeof metadata.sessionId === "string" ? metadata.sessionId : "")
		};
	}
	function ensureNativeChildObservation(params) {
		const { entry, childThreadId } = params;
		const state = nativeChildLineage(entry);
		state.support = "supported";
		state.status = "partial";
		const parentToolCallId = typeof params.metadata.triggeringToolCallId === "string" ? params.metadata.triggeringToolCallId : void 0;
		const role = typeof params.metadata.role === "string" ? params.metadata.role : parentToolCallId ? state.spawnAgentRoles.get(parentToolCallId) : void 0;
		const metadata = role ? {
			...params.metadata,
			role
		} : params.metadata;
		const childTurnId = params.childTurnId ?? (typeof metadata.childTurnId === "string" ? metadata.childTurnId : void 0) ?? state.currentChildTurnIds.get(childThreadId);
		if (!childTurnId) {
			markNativeChildPending(entry, childThreadId);
			return;
		}
		state.currentChildTurnIds.set(childThreadId, childTurnId);
		const existingObservation = findNativeChildObservation(entry, childThreadId, childTurnId);
		if (existingObservation) {
			if (role && existingObservation.role !== role) {
				const childEntry = existingObservation.traceEntry;
				const parentAgentId = nativeChildLedgerIdentity(entry).agentId;
				const nextMetadata = {
					...childEntry.traceMetadata,
					role
				};
				if (beginSdkEnqueue(childEntry, existingObservation.id, "trace-create", "codex native-child role enrichment")) {
					childEntry.traceMetadata = nextMetadata;
					childEntry.trace.update({
						name: nativeChildTraceName(parentAgentId !== "unknown" ? parentAgentId : void 0, role),
						metadata: nextMetadata
					});
					existingObservation.role = role;
				} else noteNativeChildPartial(entry, "child_delivery_rejected");
			}
			if (typeof metadata.model === "string") existingObservation.model = metadata.model;
			return existingObservation;
		}
		if (!parentToolCallId) {
			markNativeChildPending(entry, childThreadId);
			noteNativeChildPartial(entry, "child_observation_pending_spawn_ownership");
			return;
		}
		rememberNativeChildTriggeringTool(entry, childThreadId, parentToolCallId);
		const parentToolSpan = entry.pendingSpans.get(parentToolCallId) ?? entry.completedSpans?.get(parentToolCallId);
		if (!parentToolSpan) {
			markNativeChildPending(entry, childThreadId);
			noteNativeChildPartial(entry, "child_observation_pending_spawn_tool");
			return;
		}
		clearNativeChildPending(entry, childThreadId);
		const childTraceId = nativeChildTraceId(entry.traceId, childThreadId, childTurnId);
		const spawnObservationId = generateObservationId(entry.traceId, "span", parentToolCallId);
		const identity = nativeChildLedgerIdentity(entry, params);
		return ensureNativeChildObservationState(entry, childThreadId, childTurnId, () => {
			if (!writeTraceMarker(serviceStateDir, identity.agentId, identity.sessionId, "start", childTraceId, serviceLogger, {
				correlationKey: `native-child:${entry.traceId}:${childThreadId}:${childTurnId}`,
				startedAt: params.timestamp,
				traceKind: "native-child",
				sessionKey: typeof entry.traceMetadata?.sessionKey === "string" ? entry.traceMetadata.sessionKey : void 0,
				parentTraceId: entry.traceId,
				spawnObservationId,
				childThreadId,
				childTurnId
			})) {
				noteNativeChildPartial(entry, "child_ledger_start_failed");
				return;
			}
			const childTraceMetadata = {
				source: params.source,
				actorKind: "native-child",
				sessionId: identity.sessionId,
				sessionKey: entry.traceMetadata?.sessionKey,
				agentId: identity.agentId,
				parentTraceId: entry.traceId,
				parentTraceUrl: `${langfuseTraceBaseUrl}/trace/${entry.traceId}`,
				spawnObservationId,
				childTraceId,
				childThreadId,
				childTurnId,
				...metadata
			};
			if (!beginRootTraceSdkEnqueue(childTraceId, `${params.source} child trace`)) {
				noteNativeChildPartial(entry, "child_delivery_rejected");
				return;
			}
			const childTrace = langfuse?.trace({
				id: childTraceId,
				name: nativeChildTraceName(identity.agentId !== "unknown" ? identity.agentId : void 0, role),
				sessionId: typeof entry.traceMetadata?.sessionKey === "string" ? entry.traceMetadata.sessionKey : identity.sessionId,
				input: {
					actorKind: "native-child",
					...identity.agentId !== "unknown" ? { agentId: identity.agentId } : {},
					...role ? { role } : {},
					childThreadId,
					childTurnId
				},
				metadata: childTraceMetadata
			});
			if (!childTrace) {
				noteNativeChildPartial(entry, "child_trace_unavailable");
				return;
			}
			const childEntry = {
				trace: childTrace,
				traceId: childTraceId,
				actorKind: "native-child",
				traceMetadata: childTraceMetadata,
				llmCallCount: 0,
				toolCallCount: 0,
				pendingGenerations: /* @__PURE__ */ new Map(),
				pendingGenIds: /* @__PURE__ */ new Map(),
				completedGenerations: /* @__PURE__ */ new Map(),
				pendingSpans: /* @__PURE__ */ new Map(),
				completedSpanToolCallIds: /* @__PURE__ */ new Set(),
				createdAt: params.timestamp,
				timestamp: params.timestamp,
				sessionId: identity.sessionId,
				lastRuntime: entry.lastRuntime,
				lastRuntimeEngine: entry.lastRuntimeEngine,
				lastRuntimeTransport: entry.lastRuntimeTransport
			};
			if (beginSdkEnqueue(entry, spawnObservationId, "span-update", `${params.source} spawn link`)) parentToolSpan.update({ metadata: {
				source: params.source,
				parentTraceId: entry.traceId,
				spawnObservationId,
				childTraceId,
				childTraceUrl: `${langfuseTraceBaseUrl}/trace/${childTraceId}`,
				childThreadId,
				childTurnId
			} });
			else noteNativeChildPartial(entry, "spawn_link_delivery_rejected");
			return {
				id: childTraceId,
				traceEntry: childEntry,
				spawnObservationId,
				childThreadId,
				childTurnId,
				ended: false,
				...role ? { role } : {},
				...typeof metadata.model === "string" ? { model: metadata.model } : {}
			};
		});
	}
	function updateNativeChildObservation(entry, observation, event) {
		const metadata = nativeChildLifecycleMetadata(event);
		if (event.role) observation.role = event.role;
		if (event.model) {
			observation.model = event.model;
			observation.traceEntry.lastModel = event.model;
		}
		const terminal = event.lifecycle === "turn_completed" || event.lifecycle === "ended";
		if (observation.ended && !terminal) {
			noteNativeChildPartial(entry, "activity_after_terminal");
			noteNativeChildProducerUnhealthy(entry);
			return;
		}
		const childEntry = observation.traceEntry;
		if (!beginSdkEnqueue(childEntry, observation.id, "trace-create", "codex native-child diagnostic trace update")) {
			noteNativeChildPartial(entry, "child_delivery_rejected");
			return;
		}
		const childMetadata = {
			...childEntry.traceMetadata,
			source: "codex_native_child_diagnostic",
			...metadata
		};
		const publishTerminalFallback = terminal && !observation.traceOutputPublished;
		childEntry.traceMetadata = childMetadata;
		childEntry.trace.update({
			metadata: childMetadata,
			...publishTerminalFallback ? { output: { outcome: event.outcome ?? "completed" } } : {},
			...event.outcome && event.outcome !== "completed" ? {
				level: "ERROR",
				statusMessage: `native_child_${event.outcome}`
			} : {}
		});
		if (publishTerminalFallback) observation.traceOutputPublished = true;
		if (terminal && !observation.ended) {
			observation.ended = true;
			observation.pendingTerminalIdentity = nativeChildLedgerIdentity(entry, event);
		}
	}
	function finalizePendingNativeChildObservations(entry) {
		for (const observation of nativeChildLineage(entry).observations.values()) {
			const identity = observation.pendingTerminalIdentity;
			const childEntry = observation.traceEntry;
			if (!identity || childEntry.deliveryFinalized || childEntry.finalizationInProgress) continue;
			observation.pendingTerminalIdentity = void 0;
			childEntry.finalized = true;
			childEntry.finalizationInProgress = true;
			trackRuntimeTask(finalizeTraceDelivery(childEntry, identity.agentId, identity.sessionId, "native-child terminal").finally(() => completeTraceFinalization(childEntry)));
		}
	}
	function handleNativeChildDiagnostic(entry, event) {
		try {
			if (event.sessionId && !entry.sessionId) entry.sessionId = event.sessionId;
			const state = nativeChildLineage(entry);
			if (!isSupportedNativeChildDiagnosticVersion(event)) {
				state.support = "unsupported";
				state.status = "unsupported";
				state.droppedEvents += 1;
				noteNativeChildPartial(entry, "unknown_event_version");
				noteNativeChildProducerUnhealthy(entry);
				return;
			}
			if (event.type === "codex.native_child.status") {
				if (entry.deliveryFinalized) return;
				applyNativeChildTurnStatus(entry, event, true);
				return;
			}
			if (event.childTurnId) state.currentChildTurnIds.set(event.childThreadId, event.childTurnId);
			const childTurnId = event.childTurnId ?? state.currentChildTurnIds.get(event.childThreadId);
			const existingObservation = findNativeChildObservation(entry, event.childThreadId, childTurnId);
			const pendingDetachedChildTurn = Boolean(event.childTurnId && event.triggeringToolCallId && state.pendingChildThreads.has(event.childThreadId));
			if (existingObservation?.traceEntry.deliveryFinalized) {
				noteNativeChildPostFinalization(entry);
				noteNativeChildProducerUnhealthy(entry);
				return;
			}
			if (entry.deliveryFinalized && !existingObservation && !pendingDetachedChildTurn) {
				noteNativeChildPostFinalization(entry);
				noteNativeChildProducerUnhealthy(entry);
				return;
			}
			if (!admitNativeChildLifecycle(entry, event, { allowAfterRootFinalization: existingObservation !== void 0 && !existingObservation.traceEntry.deliveryFinalized || pendingDetachedChildTurn })) return;
			const pendingLifecycleEvents = state.pendingLifecycleEvents.get(event.childThreadId) ?? [];
			pendingLifecycleEvents.push(event);
			state.pendingLifecycleEvents.set(event.childThreadId, pendingLifecycleEvents);
			const metadata = nativeChildLifecycleMetadata(event);
			const observation = ensureNativeChildObservation({
				entry,
				childThreadId: event.childThreadId,
				childTurnId,
				timestamp: event.sourceTimestampMs,
				metadata,
				source: "codex_native_child_diagnostic",
				...event.agentId ? { agentId: event.agentId } : {},
				...event.sessionId ? { sessionId: event.sessionId } : {}
			});
			if (observation) {
				state.pendingLifecycleEvents.delete(event.childThreadId);
				clearNativeChildPending(entry, event.childThreadId);
				for (const pendingEvent of pendingLifecycleEvents) updateNativeChildObservation(entry, observation, pendingEvent);
			}
		} catch (error) {
			serviceLogger?.warn?.(`Langfuse: Codex native-child tracing failed open — ${String(error)}`);
		}
	}
	function reserveRootTraceIdentity(ctx, metadataSource) {
		const primaryKey = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
		const runKey = `${primaryKey}\u0000${ctx.runId ?? "unknown"}`;
		const existing = pendingRootTraceIdentities.get(runKey) ?? (ctx.runId ? pendingRootTraceIdentities.get(`${primaryKey}\u0000unknown`) : void 0);
		if (existing) return existing;
		prunePendingRootTraceIdentities();
		const persistedMarker = readOpenTraceMarkerByCorrelation(serviceStateDir, ctx.agentId ?? "unknown", ctx.sessionId ?? "", runKey);
		const timestamp = persistedMarker?.timestamp ?? Math.max(Date.now(), lastRootTraceTimestamp + 1);
		lastRootTraceTimestamp = Math.max(lastRootTraceTimestamp, timestamp);
		const traceId = persistedMarker?.traceId ?? generateTraceId(ctx.sessionKey ?? "unknown", timestamp);
		const tags = [
			ctx.agentId,
			ctx.channelId,
			...config.tracing?.tags ?? []
		].filter((tag) => Boolean(tag));
		const traceMetadata = {
			sessionId: ctx.sessionId,
			sessionKey: ctx.sessionKey,
			agentId: ctx.agentId,
			channelId: ctx.channelId,
			trigger: ctx.trigger,
			timestamp,
			...metadataSource ? { source: metadataSource } : {}
		};
		if (!persistedMarker && !writeTraceMarker(serviceStateDir, ctx.agentId ?? "unknown", ctx.sessionId ?? "", "start", traceId, serviceLogger, { correlationKey: runKey })) return;
		const identity = {
			key: runKey,
			traceId,
			timestamp,
			tags,
			traceMetadata,
			createdAt: Date.now()
		};
		pendingRootTraceIdentities.set(runKey, identity);
		return identity;
	}
	function materializeRootTrace(ctx, identity, enqueueSource, runId) {
		if (!langfuse || !contextMap || !beginRootTraceSdkEnqueue(identity.traceId, enqueueSource)) return;
		const entry = {
			trace: langfuse.trace({
				id: identity.traceId,
				name: ctx.agentId ?? "agent",
				sessionId: ctx.sessionKey,
				tags: identity.tags,
				metadata: identity.traceMetadata
			}),
			traceId: identity.traceId,
			traceMetadata: identity.traceMetadata,
			llmCallCount: 0,
			toolCallCount: 0,
			pendingGenerations: /* @__PURE__ */ new Map(),
			pendingGenIds: /* @__PURE__ */ new Map(),
			completedGenerations: /* @__PURE__ */ new Map(),
			...runId ? { runIds: /* @__PURE__ */ new Set([runId]) } : {},
			pendingSpans: /* @__PURE__ */ new Map(),
			completedSpanToolCallIds: /* @__PURE__ */ new Set(),
			createdAt: identity.timestamp,
			timestamp: identity.timestamp,
			sessionId: ctx.sessionId
		};
		contextMap.create(TraceContextMap.key(ctx.agentId, ctx.sessionKey), entry);
		pendingRootTraceIdentities.delete(identity.key);
		hydratePendingPromptState(ctx, entry);
		return entry;
	}
	function codexRolloutOwnsToolSpans(entry) {
		return isCodexRuntime(entry) && (entry.hasProviderRequestGenerations === true || entry.providerRequestAugmentedHookGenerations === true);
	}
	function codexRolloutMayOwnToolSpans(entry) {
		return codexRolloutOwnsToolSpans(entry) || unsubscribeDiagnostics !== null && isCodexRuntime(entry);
	}
	function shouldDeferCodexTranscriptToolSpans(entry) {
		return codexRolloutOwnsToolSpans(entry) || !entry.finalized && codexRolloutMayOwnToolSpans(entry);
	}
	function rememberPromptState(ctx, state) {
		prunePendingPromptStates();
		const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
		const entry = getEntry(ctx.agentId, ctx.sessionKey);
		if (entry && !entry.finalized) {
			applyPromptState(entry, state);
			pendingPromptStates.delete(key);
			return;
		}
		pendingPromptStates.delete(key);
		pendingPromptStates.set(key, state);
		prunePendingPromptStates();
	}
	function hydratePendingPromptState(ctx, entry) {
		prunePendingPromptStates();
		const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
		const state = pendingPromptStates.get(key);
		if (!state) return;
		applyPromptState(entry, state);
		pendingPromptStates.delete(key);
	}
	const handlers = {
		async beforePromptBuild(event, ctx) {
			if (disabled || !langfuse) return;
			const entry = getEntry(ctx.agentId, ctx.sessionKey);
			serviceLogger?.debug?.(`Langfuse: beforePromptBuild — entry=${entry ? "found" : "null"} prompt=${event.prompt ? `${event.prompt.length}chars` : "empty"}`);
			if (promptManager) {
				const agentId = ctx.agentId ?? "unknown";
				const syncResult = promptManager.resolveSync(agentId, {
					agentId: ctx.agentId,
					channelId: ctx.channelId,
					sessionKey: ctx.sessionKey,
					trigger: ctx.trigger
				});
				serviceLogger?.debug?.(`Langfuse: resolveSync(${agentId}) → ${syncResult ? `hit: ${syncResult.matchInfo.name}` : "miss"}`);
				if (syncResult) {
					serviceLogger?.info?.(`Langfuse: prompt injection ${promptInjectionLogSummary(syncResult)}`);
					rememberPromptState(ctx, promptStateFromResolveResult(syncResult));
					return syncResult.injection;
				}
				try {
					const result = await promptManager.resolve(agentId, {
						agentId: ctx.agentId,
						channelId: ctx.channelId,
						sessionKey: ctx.sessionKey,
						trigger: ctx.trigger
					});
					if (result) {
						serviceLogger?.info?.(`Langfuse: prompt injection ${promptInjectionLogSummary(result)}`);
						rememberPromptState(ctx, promptStateFromResolveResult(result));
						return result.injection;
					}
				} catch {}
			} else if (config.prompts?.length) {
				const rule = findMatchingRule(ctx.agentId ?? "unknown", config.prompts);
				if (rule) rememberPromptState(ctx, {
					matchInfo: {
						name: rule.langfusePrompt,
						version: rule.version,
						label: rule.label,
						inject: rule.inject,
						matchRule: rule.match
					},
					createdAt: Date.now()
				});
			}
		},
		beforeAgentRun(event, ctx) {
			try {
				if (disabled || !tracingEnabled || !langfuse || !contextMap) return { outcome: "pass" };
				const existingKey = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
				let entry = contextMap.get(existingKey);
				if (entry?.finalized) entry = void 0;
				if (!entry) {
					const identity = reserveRootTraceIdentity(ctx);
					if (!identity) return { outcome: "pass" };
					entry = materializeRootTrace(ctx, identity, "before_agent_run trace", ctx.runId);
					if (!entry) return { outcome: "pass" };
					serviceLogger?.info?.(`Langfuse: trace created (agent=${ctx.agentId}, traceId=${entry.traceId})`);
				}
				const priorMessages = event.priorMessages ?? event.messages;
				const projection = normalizeBeforeAgentRunTraceContext({
					prompt: event.prompt,
					systemPrompt: event.systemPrompt,
					priorMessages,
					redactEnabled
				});
				entry.rootInput = projection.rootInput;
				entry.systemPrompt = event.systemPrompt;
				entry.priorConversation = projection.priorConversation;
				entry.modelContextMetadata = projection.metadata;
				const metadata = mergeTraceMetadata(entry, projection.metadata);
				if (beginSdkEnqueue(entry, entry.traceId, "trace-create", "before_agent_run trace update")) entry.trace.update({
					input: projection.rootInput,
					metadata
				});
			} catch (error) {
				serviceLogger?.warn?.(`Langfuse: before_agent_run tracing failed open — ${String(error)}`);
			}
			return { outcome: "pass" };
		},
		llmInput(event, ctx) {
			if (disabled || !tracingEnabled || !langfuse || !contextMap) return;
			const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
			let entry = contextMap.get(key);
			if (entry?.finalized) entry = void 0;
			if (!entry) {
				const identity = reserveRootTraceIdentity(ctx, "llm_input-fallback");
				if (!identity) return;
				entry = materializeRootTrace(ctx, identity, "llm_input fallback trace", event.runId);
				if (!entry) return;
				rememberRuntimeIdentity(entry, event);
				const projection = normalizeBeforeAgentRunTraceContext({
					prompt: event.prompt,
					systemPrompt: event.systemPrompt,
					priorMessages: event.historyMessages,
					redactEnabled
				});
				entry.rootInput = projection.rootInput;
				entry.systemPrompt = event.systemPrompt;
				entry.priorConversation = projection.priorConversation;
				entry.modelContextMetadata = projection.metadata;
				const metadata = mergeTraceMetadata(entry, {
					...projection.metadata,
					...runtimeMetadata(entry)
				});
				if (beginSdkEnqueue(entry, entry.traceId, "trace-create", "llm_input fallback trace update")) entry.trace.update({
					input: projection.rootInput,
					metadata
				});
				serviceLogger?.info?.(`Langfuse: trace created from llm_input fallback (agent=${ctx.agentId}, traceId=${entry.traceId})`);
			}
			if (event.systemPrompt && !entry.systemPrompt) entry.systemPrompt = event.systemPrompt;
			entry.lastModel = event.model;
			entry.lastProvider = event.provider;
			rememberRuntimeIdentity(entry, event);
			const runtimePatch = runtimeMetadata(entry);
			if (Object.entries(runtimePatch).some(([metadataKey, value]) => entry.traceMetadata?.[metadataKey] !== value) && beginSdkEnqueue(entry, entry.traceId, "trace-create", "llm_input runtime metadata")) entry.trace.update({ metadata: mergeTraceMetadata(entry, runtimePatch) });
			entry.sessionId = ctx.sessionId;
			(entry.runIds ??= /* @__PURE__ */ new Set()).add(event.runId);
			const seenLlmInputRunIds = llmInputRunIds(entry);
			if (seenLlmInputRunIds.has(event.runId)) {
				serviceLogger?.debug?.(`Langfuse: skipped duplicate llmInput for runId=${event.runId}`);
				return;
			}
			if (entry.hasProviderRequestGenerations) {
				serviceLogger?.debug?.(`Langfuse: skipped llmInput generation because provider-request diagnostics own this trace (runId=${event.runId})`);
				return;
			}
			seenLlmInputRunIds.add(event.runId);
			entry.llmCallCount += 1;
			const genId = generateObservationId(entry.traceId, "gen", entry.llmCallCount);
			const model = qualifiedModel(event.provider, event.model);
			const startTime = /* @__PURE__ */ new Date();
			const allMessages = buildLlmInputMessages(Array.isArray(event.historyMessages) ? event.historyMessages : [], event.prompt);
			const canonicalMessages = allMessages.map((message) => buildApiMessage(message)).filter((message) => message.role !== "system");
			const normalizedInput = normalizeModelCallInput({
				model: event.model,
				systemPrompt: entry.systemPrompt,
				messages: canonicalMessages,
				previousMessages: entry.previousModelInputMessages,
				...entry.previousModelInputMessages === void 0 && typeof entry.rootInput === "string" ? { firstGenerationInput: entry.rootInput } : {},
				redactEnabled
			});
			entry.previousModelInputMessages = normalizedInput.nextMessages;
			entry.lastHistoryLength = allMessages.length;
			if (Object.keys(normalizedInput.traceMetadata).length > 0) {
				entry.modelContextMetadata = {
					...normalizedInput.traceMetadata,
					...entry.modelContextMetadata
				};
				if (entry.priorConversation === void 0 && normalizedInput.priorConversation !== void 0) entry.priorConversation = normalizedInput.priorConversation;
				const metadata = mergeTraceMetadata(entry, entry.modelContextMetadata);
				if (!beginSdkEnqueue(entry, entry.traceId, "trace-create", "llm_input model context trace update")) return;
				entry.modelContextMetadataPublished = true;
				entry.trace.update({ metadata });
			}
			const genInput = normalizedInput.generationInput;
			if (!appendObservationEventOrMark(entry, ctx.agentId ?? "unknown", ctx.sessionId ?? "", {
				e: "gen-start",
				traceId: entry.traceId,
				id: genId,
				llmCall: entry.llmCallCount,
				model,
				ts: startTime.toISOString()
			}, "llm_input")) return;
			if (!beginSdkEnqueue(entry, genId, "generation-create", "llm_input generation")) return;
			const generation = entry.trace.generation({
				id: genId,
				name: `llm-call-${entry.llmCallCount}`,
				model,
				startTime,
				input: genInput,
				...entry.promptClient ? { prompt: entry.promptClient } : {},
				metadata: {
					provider: event.provider,
					model: event.model,
					...runtimeMetadata(entry)
				}
			});
			entry.pendingGenerations.set(event.runId, generation);
			entry.pendingGenIds.set(event.runId, genId);
			entry.currentGenerationId = genId;
			serviceLogger?.debug?.(`Langfuse: created generation ${genId} (llm-call-${entry.llmCallCount}) at llmInput`);
		},
		llmOutput(event, ctx) {
			if (disabled || !tracingEnabled || !langfuse) return;
			const entry = getEntry(ctx.agentId, ctx.sessionKey);
			if (!entry) return;
			entry.storedUsage = event.usage;
			entry.storedOutput = event.assistantTexts.join("\n");
			entry.lastModel = event.model;
			entry.lastProvider = event.provider;
			rememberRuntimeIdentity(entry, event);
			(entry.runIds ??= /* @__PURE__ */ new Set()).add(event.runId);
			if (entry.hasProviderRequestGenerations || entry.providerRequestAugmentedHookGenerations) {
				serviceLogger?.debug?.(`Langfuse: skipped aggregate llmOutput because provider-request diagnostics own this trace (runId=${event.runId})`);
				return;
			}
			const pendingGen = entry.pendingGenerations.get(event.runId);
			if (pendingGen) {
				const endTime = /* @__PURE__ */ new Date();
				const liveAssistantContent = (event.lastAssistant ? event.lastAssistant.content ?? event.lastAssistant : void 0) ?? (entry.storedOutput.trim() ? entry.storedOutput : void 0);
				const output = liveAssistantContent ? buildGenerationOutput(liveAssistantContent, redactEnabled) : void 0;
				const truncatedOutput = output !== void 0 && output !== null && output !== "" ? truncatePayload(output) : void 0;
				const eu = event.usage;
				const usageDetails = usageDetailsFromUsage(eu);
				entry.lastGenerationEndTime = endTime;
				const genId = entry.pendingGenIds.get(event.runId);
				if (genId && !appendObservationEventOrMark(entry, ctx.agentId ?? "unknown", ctx.sessionId ?? "", {
					e: "gen-end",
					traceId: entry.traceId,
					id: genId,
					ts: endTime.toISOString()
				}, "llm_output")) return;
				if (!beginSdkEnqueue(entry, genId ?? entry.traceId, "generation-update", "llm_output generation update")) return;
				pendingGen.update({
					endTime,
					...truncatedOutput !== void 0 ? { output: truncatedOutput } : {},
					...usageDetails ? { usageDetails } : {},
					metadata: {
						provider: event.provider,
						model: event.model,
						...runtimeMetadata(entry)
					}
				});
				if (entry.storedOutput.trim() && beginSdkEnqueue(entry, entry.traceId, "trace-create", "llm_output trace update")) entry.trace.update({ output: truncatePayload(redactText(entry.storedOutput, redactEnabled)) });
				entry.pendingGenerations.delete(event.runId);
				entry.completedGenerations.set(entry.llmCallCount, pendingGen);
				if (genId) (entry.completedGenerationIds ??= /* @__PURE__ */ new Map()).set(entry.llmCallCount, genId);
				applyDeferredProviderRequestCompletion(entry, entry.llmCallCount, pendingGen);
				entry.pendingGenIds.delete(event.runId);
				serviceLogger?.debug?.(`Langfuse: updated generation at llmOutput (runId=${event.runId})`);
			} else serviceLogger?.debug?.(`Langfuse: llmOutput — no pending generation for runId=${event.runId}, stored for agentEnd fallback`);
		},
		beforeToolCall(event, ctx) {
			if (disabled || !tracingEnabled || !langfuse) return;
			let entry = getEntry(ctx.agentId, ctx.sessionKey);
			if (!entry && contextMap) entry = contextMap.findActive(ctx.sessionKey);
			if (!entry) return;
			if (codexRolloutMayOwnToolSpans(entry)) return;
			const toolCallId = event.toolCallId ?? ctx.toolCallId ?? `${event.toolName}-${entry.toolCallCount + 1}`;
			if (entry.pendingSpans.has(toolCallId) || entry.completedSpanToolCallIds.has(toolCallId)) return;
			const startTime = /* @__PURE__ */ new Date();
			const spanId = generateObservationId(entry.traceId, "span", toolCallId);
			if (!appendObservationEventOrMark(entry, ctx.agentId ?? "unknown", entry.sessionId ?? ctx.sessionId ?? "", {
				e: "span-start",
				traceId: entry.traceId,
				id: spanId,
				tool: event.toolName,
				toolCallId,
				ts: startTime.toISOString()
			}, "before_tool_call")) return;
			if (!beginSdkEnqueue(entry, spanId, "span-create", "before_tool_call span")) return;
			const span = (resolveCurrentGeneration(entry) ?? entry.trace).span({
				id: spanId,
				name: `tool:${event.toolName}`,
				startTime,
				input: redactObject(truncatePayload(event.params), redactEnabled),
				metadata: {
					toolName: event.toolName,
					toolCallId
				}
			});
			entry.pendingSpans.set(toolCallId, span);
			entry.toolCallCount += 1;
			serviceLogger?.debug?.(`Langfuse: created tool span ${spanId}`);
		},
		afterToolCall(event, ctx) {
			if (disabled || !tracingEnabled || !langfuse) return;
			const toolCallId = event.toolCallId ?? ctx.toolCallId;
			let entry = getEntry(ctx.agentId, ctx.sessionKey);
			if (!entry && toolCallId && contextMap) entry = contextMap.findByPendingSpan(toolCallId);
			if (!entry && contextMap) entry = contextMap.findActive(ctx.sessionKey);
			if (!entry) return;
			if (codexRolloutMayOwnToolSpans(entry)) return;
			const resolvedToolCallId = toolCallId ?? `${event.toolName}-${Math.max(entry.toolCallCount, 1)}`;
			let span = entry.pendingSpans.get(resolvedToolCallId);
			const spanId = generateObservationId(entry.traceId, "span", resolvedToolCallId);
			if (!span && !entry.completedSpanToolCallIds.has(resolvedToolCallId)) {
				const endMs = Date.now();
				const startTime = typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? new Date(Math.max(0, endMs - event.durationMs)) : new Date(endMs);
				const spanOwner = resolveCurrentGeneration(entry) ?? entry.trace;
				if (!appendObservationEventOrMark(entry, ctx.agentId ?? "unknown", entry.sessionId ?? ctx.sessionId ?? "", {
					e: "span-start",
					traceId: entry.traceId,
					id: spanId,
					tool: event.toolName,
					toolCallId: resolvedToolCallId,
					ts: startTime.toISOString()
				}, "after_tool_call_fallback")) return;
				if (!beginSdkReconstructionEnqueue(entry, spanId, "span-create", "after_tool_call fallback span")) return;
				span = spanOwner.span({
					id: spanId,
					name: `tool:${event.toolName}`,
					startTime,
					input: redactObject(truncatePayload(event.params), redactEnabled),
					metadata: {
						toolName: event.toolName,
						toolCallId: resolvedToolCallId,
						source: "afterToolCall-fallback"
					}
				});
				entry.pendingSpans.set(resolvedToolCallId, span);
				entry.toolCallCount += 1;
			}
			if (!span) return;
			const endTime = /* @__PURE__ */ new Date();
			const isError = event.isError === true || Boolean(event.error);
			const outputPayload = event.result !== void 0 ? event.result : event.error ? { error: event.error } : void 0;
			const statusMessage = isError ? safeToolErrorStatusMessage(event.error, redactEnabled) : void 0;
			if (!appendObservationEventOrMark(entry, ctx.agentId ?? "unknown", entry.sessionId ?? ctx.sessionId ?? "", {
				e: "span-end",
				traceId: entry.traceId,
				id: spanId,
				ts: endTime.toISOString()
			}, "after_tool_call")) return;
			if (!beginSdkEnqueue(entry, spanId, "span-update", "after_tool_call span update")) return;
			span.update({
				endTime,
				output: redactObject(truncatePayload(outputPayload), redactEnabled),
				metadata: {
					toolName: event.toolName,
					toolCallId: resolvedToolCallId,
					...isError ? { isError: true } : {},
					...typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}
				},
				...isError ? {
					level: "ERROR",
					statusMessage
				} : {}
			});
			entry.pendingSpans.delete(resolvedToolCallId);
			(entry.completedSpans ??= /* @__PURE__ */ new Map()).set(resolvedToolCallId, span);
			entry.completedSpanToolCallIds.add(resolvedToolCallId);
			serviceLogger?.debug?.(`Langfuse: completed tool span ${spanId}`);
		},
		async agentEnd(event, ctx) {
			if (disabled || !tracingEnabled || !langfuse || !contextMap) return;
			const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
			let entry = contextMap.get(key);
			let isRecoveryEntry = false;
			if (!entry) {
				isRecoveryEntry = true;
				const identity = reserveRootTraceIdentity(ctx, "agent_end-recovery");
				if (!identity) return;
				entry = materializeRootTrace(ctx, identity, "agent_end recovery trace", ctx.runId);
				if (!entry) return;
				serviceLogger?.info?.(`Langfuse: trace created from agentEnd recovery (agent=${ctx.agentId}, traceId=${entry.traceId})`);
			}
			const diagnosticCursorIdentity = ctx.runId || ctx.sessionKey || ctx.sessionId ? {
				...ctx.runId ? { runId: ctx.runId } : {},
				...ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {},
				...ctx.sessionId ? { sessionId: ctx.sessionId } : {}
			} : void 0;
			const diagnosticCursor = diagnosticCursorIdentity ? internalDiagnosticDelivery?.captureDeliveryCursor(diagnosticCursorIdentity) : void 0;
			if (entry.deliveryFinalized || entry.finalizationInProgress) {
				serviceLogger?.debug?.(`Langfuse: duplicate agentEnd ignored (traceId=${entry.traceId}, deliveryFinalized=${entry.deliveryFinalized === true})`);
				return;
			}
			entry.finalizationDiagnosticSequence = diagnosticCursor?.sequence;
			if (diagnosticCursor) entry.diagnosticAdmissionClosed = true;
			entry.transcriptAdmissionClosed = true;
			entry.finalizationInProgress = true;
			let finalizationDeferred = false;
			const canonicalRootOutput = canonicalAgentEndAssistantText(Array.isArray(event.messages) ? event.messages : []);
			try {
				const agentId = ctx.agentId ?? "unknown";
				const sessionId = entry.sessionId ?? ctx.sessionId ?? "";
				const diagnosticDrain = diagnosticCursor ? await internalDiagnosticDelivery.waitForDeliveryCursor(diagnosticCursor, { timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS }) : await waitForDiagnosticQuiescence(ctx, SHUTDOWN_DRAIN_TIMEOUT_MS) ? {
					ok: true,
					deliveredEvents: 0
				} : {
					ok: false,
					reason: "timeout",
					deliveredEvents: 0
				};
				if (!diagnosticCursor) entry.diagnosticAdmissionClosed = true;
				if (!diagnosticDrain.ok) {
					markObservationBarrierFailed(entry, `diagnostic_drain_${diagnosticDrain.reason}`, "agent_end", 1);
					serviceLogger?.warn?.(`Langfuse: diagnostic cursor drain failed before agentEnd reconciliation (reason=${diagnosticDrain.reason}, traceId=${entry.traceId})`);
				}
				await closeTranscriptAdmissionAndDrain(entry, ctx.sessionKey, "agent_end");
				let allEntries = [];
				let turnEntries = [];
				if (sessionId && ctx.sessionKey) {
					allEntries = await readSessionMessagesByIdentity({
						agentId,
						sessionId,
						sessionKey: ctx.sessionKey
					}, serviceLogger);
					turnEntries = filterCurrentTurnEntries(allEntries);
				}
				if (turnEntries.length === 0 && Array.isArray(event.messages)) {
					serviceLogger?.warn?.(`Langfuse: transcript unavailable for agent=${agentId} session=${sessionId}, using event.messages fallback`);
					const now = Date.now();
					const fallbackEntries = event.messages.map((msg, i) => ({
						timestamp: typeof msg.timestamp === "number" ? msg.timestamp : now - (event.messages.length - i) * 1e3,
						message: msg
					}));
					turnEntries = filterCurrentTurnEntries(fallbackEntries);
					if (turnEntries.length === 0) turnEntries = fallbackEntries;
					allEntries = turnEntries;
				}
				let lastAssistantText;
				const useBatchCreation = isRecoveryEntry || entry.llmCallCount === 0;
				serviceLogger?.info?.(`Langfuse: agentEnd path — useBatchCreation=${useBatchCreation} isRecovery=${isRecoveryEntry} llmCallCount=${entry.llmCallCount} completedGens=${entry.completedGenerations.size} turnEntries=${turnEntries.length}`);
				let batchTotalUsage;
				let batchReportedUsageFields;
				let batchHasReportedUsage = false;
				if (useBatchCreation) {
					const obsResult = await buildObservationsFromEntries(entry.trace, entry.traceId, turnEntries, allEntries, {
						entryTimestamp: entry.timestamp,
						systemPrompt: entry.systemPrompt,
						storedUsage: entry.storedUsage,
						promptClient: entry.promptClient,
						lastModel: entry.lastModel,
						lastProvider: entry.lastProvider,
						redactEnabled,
						langfuseClient: langfuse ?? void 0,
						existingToolCallIds: /* @__PURE__ */ new Set([...entry.pendingSpans.keys(), ...entry.completedSpanToolCallIds]),
						recordObservationEvent: (observationEvent, source) => appendObservationEventOrMark(entry, agentId, sessionId, observationEvent, source),
						onBeforeSdkEnqueue: async (observationId, eventType, source) => {
							const accepted = await beginSdkEnqueueWithBackpressure(entry, observationId, eventType, source);
							if (accepted) clearSupersededSdkDeliveryFailures(entry, observationId);
							return accepted;
						}
					}, serviceLogger);
					entry.llmCallCount = obsResult.llmCallCount;
					entry.completedGenerations = obsResult.completedGenerations;
					entry.completedGenerationIds = obsResult.completedGenerationIds;
					if (Object.keys(obsResult.modelContextMetadata).length > 0) {
						entry.modelContextMetadata = obsResult.modelContextMetadata;
						entry.priorConversation = obsResult.priorConversation;
					}
					if (obsResult.observationBarrierIncomplete) markObservationBarrierFailed(entry, "batch_reconciliation_incomplete", "agent_end");
					applyDeferredProviderRequestCompletions(entry);
					entry.toolCallCount = Math.max(entry.toolCallCount, obsResult.toolCallCount);
					lastAssistantText = obsResult.lastAssistantText;
					if (obsResult.lastModel) entry.lastModel = obsResult.lastModel;
					if (obsResult.lastProvider) entry.lastProvider = obsResult.lastProvider;
					batchTotalUsage = obsResult.totalUsage;
					batchReportedUsageFields = obsResult.reportedUsageFields;
					batchHasReportedUsage = obsResult.hasReportedUsage;
				} else {
					finalizeIncrementalObservations(entry, turnEntries, allEntries, agentId, sessionId, redactEnabled, {
						logger: serviceLogger,
						stateDir: serviceStateDir,
						langfuseClient: langfuse,
						onBeforeSdkEnqueue: beginSdkReconstructionEnqueue
					});
					applyDeferredProviderRequestCompletions(entry);
				}
				if (!lastAssistantText) for (let i = turnEntries.length - 1; i >= 0; i--) {
					const candidate = turnEntries[i];
					if (candidate && isTraceableAssistantEntry(candidate)) {
						const text = extractTextContent(candidate.message.content);
						if (text) {
							lastAssistantText = text;
							break;
						}
					}
				}
				let aggregatedUsage;
				let aggregatedUsageFields;
				if (turnEntries.length > 0) {
					const acc = {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0
					};
					const fields = {
						input: false,
						output: false,
						cacheRead: false,
						cacheWrite: false,
						total: false
					};
					for (const te of turnEntries) {
						const msg = te.message;
						if (!isTraceableAssistantEntry(te)) continue;
						const u = msg.usage;
						if (!u) continue;
						const input = finiteUsageNumber(u.input);
						const output = finiteUsageNumber(u.output);
						const cacheRead = finiteUsageNumber(u.cacheRead);
						const cacheWrite = finiteUsageNumber(u.cacheWrite);
						const explicitTotal = finiteUsageNumber(u.totalTokens) ?? finiteUsageNumber(u.total);
						if (input !== void 0) {
							acc.input += input;
							fields.input = true;
						}
						if (output !== void 0) {
							acc.output += output;
							fields.output = true;
						}
						if (cacheRead !== void 0) {
							acc.cacheRead += cacheRead;
							fields.cacheRead = true;
						}
						if (cacheWrite !== void 0) {
							acc.cacheWrite += cacheWrite;
							fields.cacheWrite = true;
						}
						if (explicitTotal !== void 0) {
							acc.total += explicitTotal;
							fields.total = true;
						} else if (input !== void 0 || output !== void 0) {
							acc.total += (input ?? 0) + (output ?? 0);
							fields.total = true;
						}
					}
					if (Object.values(fields).some(Boolean)) {
						aggregatedUsage = acc;
						aggregatedUsageFields = fields;
					}
					serviceLogger?.info?.(`Langfuse: usage from turnEntries — input=${acc.input} output=${acc.output} total=${acc.total}`);
				}
				const providerUsage = completeProviderRequestUsageTotals(entry);
				if (providerUsage) entry.authoritativeProviderUsage = providerUsage;
				const storedUsageFields = usageFieldPresence(entry.storedUsage);
				const usageSrc = providerUsage ? providerUsage : aggregatedUsage ? aggregatedUsage : batchTotalUsage && batchHasReportedUsage ? batchTotalUsage : Object.values(storedUsageFields).some(Boolean) ? entry.storedUsage : void 0;
				const usageFields = providerUsage ? usageFieldPresence(providerUsage) : aggregatedUsage ? aggregatedUsageFields ?? usageFieldPresence(aggregatedUsage) : batchTotalUsage && batchHasReportedUsage ? batchReportedUsageFields ?? usageFieldPresence(batchTotalUsage) : storedUsageFields;
				entry.finalizedUsage = usageSrc ? { ...usageSrc } : void 0;
				const traceUsage = usageSrc;
				const finalUsage = usageSrc ? {
					...usageFields.input ? { inputTokens: traceUsage?.input } : {},
					...usageFields.output ? { outputTokens: traceUsage?.output } : {},
					...usageFields.cacheRead ? { cacheReadInputTokens: traceUsage?.cacheRead } : {},
					...usageFields.cacheWrite ? { cacheWriteInputTokens: traceUsage?.cacheWrite } : {},
					...usageFields.total ? { totalTokens: traceUsage?.total } : {},
					...typeof traceUsage?.reasoningTokens === "number" ? { reasoningTokens: traceUsage.reasoningTokens } : {}
				} : void 0;
				finalizeNativeChildLineage(entry, true);
				const finalTraceMetadata = replaceTraceMetadata(entry, {
					sessionId,
					sessionKey: ctx.sessionKey,
					agentId,
					channelId: ctx.channelId,
					trigger: ctx.trigger,
					timestamp: entry.timestamp,
					stats: {
						success: event.success,
						durationMs: event.durationMs,
						messageCount: event.messages?.length ?? turnEntries.length,
						llmCallCount: entry.llmCallCount,
						toolCallCount: entry.toolCallCount
					},
					usage: finalUsage,
					lastModel: entry.lastModel || entry.lastProvider ? {
						provider: entry.lastProvider,
						model: entry.lastModel
					} : void 0,
					...entry.modelContextMetadata,
					...runtimeMetadata(entry),
					nativeChildLineage: nativeChildLineageMetadata(entry),
					prompt: truncatePayload(entry.promptMatch),
					...entry.observationReconciliation ? { observationReconciliation: entry.observationReconciliation } : {}
				});
				if (beginSdkReconstructionEnqueue(entry, entry.traceId, "trace-create", "agent_end trace update")) entry.trace.update({
					input: entry.rootInput,
					...canonicalRootOutput ? { output: truncatePayload(redactText(canonicalRootOutput, redactEnabled)) } : {},
					metadata: finalTraceMetadata,
					...event.error ? {
						statusMessage: safeAgentErrorStatusMessage(event.error, redactEnabled),
						level: "ERROR"
					} : {}
				});
				entry.finalized = true;
				finalizationDeferred = await finalizeTraceDeliveryWithinReplyBudget(entry, agentId, sessionId, "agentEnd");
			} finally {
				if (!finalizationDeferred) completeTraceFinalization(entry);
			}
		},
		sessionEnd(event, ctx) {
			if (disabled || !tracingEnabled) return;
			serviceLogger?.debug?.(`Langfuse session end: agentId=${ctx.agentId ?? "unknown"} sessionKey=${ctx.sessionKey ?? "unknown"} messageCount=${event.messageCount} durationMs=${event.durationMs ?? "unknown"}`);
		},
		sessionStart(event, ctx) {
			if (disabled || !tracingEnabled || !langfuse || !contextMap) return;
			serviceLogger?.debug?.(`Langfuse session start: sessionId=${event.sessionId} sessionKey=${ctx.sessionKey ?? "unknown"} resumedFrom=${event.resumedFrom ?? "none"}`);
		},
		beforeMessageWrite(event, ctx) {
			if (disabled || !tracingEnabled || !contextMap) return;
			const entry = getEntry(ctx.agentId, ctx.sessionKey);
			if (!entry) return;
			const msg = event.message;
			if (!msg || typeof msg !== "object") return;
			const role = msg.role;
			if (!role) return;
			if (role === "assistant") {
				if (isTranscriptOnlyAssistantMessage(msg)) {
					serviceLogger?.debug?.("Langfuse: skipped transcript-only assistant message");
					return;
				}
				const message = { ...msg };
				transientMessageMetadata.set(message, {
					traceId: entry.traceId,
					...entry.currentGenerationId ? { genId: entry.currentGenerationId } : {}
				});
				return { message };
			}
			if (role === "toolResult" || role === "tool") {
				const toolCallId = msg.toolCallId ?? msg.tool_call_id ?? void 0;
				if (toolCallId) {
					const message = { ...msg };
					transientMessageMetadata.set(message, {
						traceId: entry.traceId,
						toolCallId
					});
					return { message };
				}
			}
		}
	};
	function normalizeTranscriptUpdate(update) {
		const sessionKey = update.sessionKey ?? update.target?.sessionKey;
		const sessionFile = update.sessionFile?.trim() || void 0;
		const agentId = update.agentId ?? update.target?.agentId ?? (sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : void 0);
		const sessionId = update.sessionId ?? update.target?.sessionId ?? sessionIdFromTranscriptFile(sessionFile);
		if (!agentId || !sessionId || !sessionKey) return null;
		return {
			...update,
			agentId,
			sessionId,
			sessionKey,
			...sessionFile ? { sessionFile } : {},
			target: {
				agentId,
				sessionId,
				sessionKey
			}
		};
	}
	function sessionIdFromTranscriptFile(sessionFile) {
		if (!sessionFile) return;
		const basename = path.basename(sessionFile);
		return basename.endsWith(".jsonl") && basename.length > 6 ? basename.slice(0, -6) : void 0;
	}
	function normalizeTranscriptUsage(usage) {
		if (!usage) return;
		const normalized = {};
		for (const key of [
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"total",
			"totalTokens"
		]) {
			const value = usage[key];
			if (typeof value === "number") normalized[key] = value;
		}
		return Object.keys(normalized).length > 0 ? normalized : void 0;
	}
	function persistedLangfuseTraceId(msg) {
		const transientTraceId = transientMessageMetadata.get(msg)?.traceId;
		if (transientTraceId) return transientTraceId;
		const traceId = metadataRecord(metadataRecord(msg.metadata)["_langfuse"]).traceId;
		return typeof traceId === "string" && traceId ? traceId : void 0;
	}
	function transcriptAdmissionEntry(update) {
		const persistedTraceId = persistedLangfuseTraceId(metadataRecord(update.message));
		if (persistedTraceId) return contextMap?.findRecent(update.sessionKey, { traceId: persistedTraceId });
		return contextMap?.findActive(update.sessionKey) ?? contextMap?.findRecent(update.sessionKey);
	}
	function isWithinFinalizedTraceTimeBoundary(messageTime, entry) {
		const messageTimeMs = messageTime?.getTime();
		if (messageTimeMs === void 0) return false;
		const stats = metadataRecord(entry.traceMetadata?.stats);
		const durationMs = typeof stats.durationMs === "number" ? stats.durationMs : void 0;
		const endCandidates = [typeof durationMs === "number" ? entry.timestamp + durationMs : void 0, entry.lastGenerationEndTime?.getTime()].filter((value) => typeof value === "number" && Number.isFinite(value));
		if (endCandidates.length === 0) return false;
		const boundaryGraceMs = 1e3;
		return messageTimeMs >= entry.timestamp - boundaryGraceMs && messageTimeMs <= Math.max(...endCandidates) + boundaryGraceMs;
	}
	function traceUsageFromEntry(entry) {
		const usage = entry.authoritativeProviderUsage ?? entry.finalizedUsage ?? entry.storedUsage;
		if (!usage) return;
		const input = finiteUsageNumber(usage.input);
		const output = finiteUsageNumber(usage.output);
		const cacheRead = finiteUsageNumber(usage.cacheRead);
		const cacheWrite = finiteUsageNumber(usage.cacheWrite);
		const total = finiteUsageNumber(usage.total) ?? (input !== void 0 || output !== void 0 ? (input ?? 0) + (output ?? 0) : void 0);
		if (input === void 0 && output === void 0 && cacheRead === void 0 && cacheWrite === void 0 && total === void 0) return;
		return {
			...input !== void 0 ? { inputTokens: input } : {},
			...output !== void 0 ? { outputTokens: output } : {},
			...cacheRead !== void 0 ? { cacheReadInputTokens: cacheRead } : {},
			...cacheWrite !== void 0 ? { cacheWriteInputTokens: cacheWrite } : {},
			...total !== void 0 ? { totalTokens: total } : {}
		};
	}
	function timestampToDate(value) {
		let ms;
		if (typeof value === "number" && Number.isFinite(value)) ms = value > 0 && value < 1e10 ? value * 1e3 : value;
		else if (typeof value === "string") {
			const parsed = Date.parse(value);
			if (Number.isFinite(parsed)) ms = parsed;
		}
		if (ms === void 0) return;
		const date = new Date(ms);
		return Number.isFinite(date.getTime()) ? date : void 0;
	}
	function persistedEntryTimestampToDate(value) {
		let ms;
		if (typeof value === "number" && Number.isFinite(value)) ms = value;
		else if (typeof value === "string") {
			const parsed = Date.parse(value);
			if (Number.isFinite(parsed)) ms = parsed;
		}
		if (ms === void 0) return;
		const date = new Date(ms);
		return Number.isFinite(date.getTime()) ? date : void 0;
	}
	function startTimeBeforeEnd(startTime, endTime) {
		if (!startTime) return;
		if (endTime && startTime.getTime() > endTime.getTime()) return;
		return startTime;
	}
	async function readTranscriptEntriesForUpdate(update) {
		return update.sessionFile ? readSessionMessagesFromFile(update.sessionFile, serviceLogger) : await readSessionMessagesByIdentity(update.target, serviceLogger);
	}
	function findPersistedTranscriptEntry(update, transcriptEntries) {
		let messageSeq = 0;
		for (const transcriptEntry of transcriptEntries) {
			messageSeq += 1;
			const persistedEntryId = transcriptEntry.id ?? transcriptEntry.entryId;
			const idMatches = Boolean(update.messageId) && persistedEntryId === update.messageId;
			const seqMatches = update.messageSeq !== void 0 && messageSeq === update.messageSeq;
			if (idMatches || seqMatches) return transcriptEntry;
		}
	}
	async function resolveTranscriptTiming(update, entry, msg, preloadedTranscriptEntries) {
		const fallbackStartTime = timestampToDate(msg.timestamp);
		if (!update.messageId && update.messageSeq === void 0) return fallbackStartTime ? { startTime: fallbackStartTime } : {};
		const transcriptEntries = preloadedTranscriptEntries ?? await readTranscriptEntriesForUpdate(update);
		if (transcriptEntries.length === 0) return fallbackStartTime ? { startTime: fallbackStartTime } : {};
		let messageSeq = 0;
		let assistantCallIndex = 0;
		for (const transcriptEntry of transcriptEntries) {
			messageSeq += 1;
			const inTraceWindow = transcriptEntry.timestamp >= entry.timestamp - 1e3;
			const isAssistant = isTraceableAssistantEntry(transcriptEntry);
			if (inTraceWindow && isAssistant) assistantCallIndex += 1;
			const persistedEntryId = transcriptEntry.id ?? transcriptEntry.entryId;
			const idMatches = Boolean(update.messageId) && persistedEntryId === update.messageId;
			const seqMatches = update.messageSeq !== void 0 && messageSeq === update.messageSeq;
			if (!idMatches && !seqMatches) continue;
			const endTime = persistedEntryTimestampToDate(transcriptEntry.timestamp);
			const startTime = startTimeBeforeEnd(timestampToDate(transcriptEntry.message.timestamp) ?? fallbackStartTime, endTime);
			return {
				...inTraceWindow && isAssistant && assistantCallIndex > 0 ? { assistantCallIndex } : {},
				...startTime ? { startTime } : {},
				...endTime ? { endTime } : {}
			};
		}
		return fallbackStartTime ? { startTime: fallbackStartTime } : {};
	}
	function patchFinalizedTraceFromTranscript(entry, redactEnabledForUpdate) {
		if (!entry.finalized) return;
		const metadataPatch = {
			source: "late-transcript-repair",
			stats: mergeTraceStats(entry, {
				llmCallCount: entry.llmCallCount,
				toolCallCount: entry.toolCallCount
			})
		};
		const usage = traceUsageFromEntry(entry);
		if (usage) metadataPatch.usage = usage;
		if (entry.lastModel || entry.lastProvider) metadataPatch.lastModel = {
			provider: entry.lastProvider,
			model: entry.lastModel
		};
		if (entry.promptMatch !== void 0) metadataPatch.prompt = entry.promptMatch;
		const traceUpdate = { metadata: mergeTraceMetadata(entry, metadataPatch) };
		if (entry.storedOutput) traceUpdate.output = String(truncatePayload(redactText(entry.storedOutput, redactEnabledForUpdate)));
		if (!beginSdkEnqueue(entry, entry.traceId, "trace-create", "late transcript trace update")) return;
		entry.trace.update(traceUpdate);
	}
	function transcriptToolResultId(msg) {
		return typeof msg.toolCallId === "string" ? msg.toolCallId : typeof msg.tool_call_id === "string" ? msg.tool_call_id : void 0;
	}
	function transcriptToolResultOutput(msg) {
		const content = msg.content;
		if (Array.isArray(content) && content.length === 1) {
			const first = content[0];
			if (first && typeof first === "object" && "content" in first) return first.content;
		}
		if ("content" in msg) return msg.content;
		if ("result" in msg) return msg.result;
	}
	function createTranscriptToolSpan(params) {
		const { entry, agentId, sessionId, toolCallId, toolName, input, startTime, redactEnabled: redactToolPayloads, source } = params;
		if (entry.pendingSpans.has(toolCallId) || entry.completedSpanToolCallIds.has(toolCallId)) return;
		const spanId = generateObservationId(entry.traceId, "span", toolCallId);
		if (!appendObservationEventOrMark(entry, agentId, sessionId, {
			e: "span-start",
			traceId: entry.traceId,
			id: spanId,
			tool: toolName,
			toolCallId,
			ts: startTime.toISOString()
		}, source)) return;
		if (!beginSdkEnqueue(entry, spanId, "span-create", `${source} span`)) return;
		const span = (resolveCurrentGeneration(entry) ?? entry.trace).span({
			id: spanId,
			name: `tool:${toolName}`,
			startTime,
			input: redactObject(truncatePayload(input), redactToolPayloads),
			metadata: {
				toolName,
				toolCallId,
				source
			}
		});
		entry.pendingSpans.set(toolCallId, span);
		entry.toolCallCount += 1;
	}
	function completeTranscriptToolSpan(params) {
		const { entry, agentId, sessionId, toolCallId, toolName, output, endTime, redactEnabled: redactToolPayloads, source, isError = false } = params;
		if (entry.completedSpanToolCallIds.has(toolCallId)) return;
		let span = entry.pendingSpans.get(toolCallId);
		const spanId = generateObservationId(entry.traceId, "span", toolCallId);
		if (!span) {
			if (!appendObservationEventOrMark(entry, agentId, sessionId, {
				e: "span-start",
				traceId: entry.traceId,
				id: spanId,
				tool: toolName,
				toolCallId,
				ts: endTime.toISOString()
			}, `${source}-fallback-start`)) return;
			if (!beginSdkReconstructionEnqueue(entry, spanId, "span-create", `${source} fallback span`)) return;
			span = (resolveCurrentGeneration(entry) ?? entry.trace).span({
				id: spanId,
				name: `tool:${toolName}`,
				startTime: endTime,
				metadata: {
					toolName,
					toolCallId,
					source: `${source}-fallback-start`
				}
			});
			entry.pendingSpans.set(toolCallId, span);
			entry.toolCallCount += 1;
		}
		if (!appendObservationEventOrMark(entry, agentId, sessionId, {
			e: "span-end",
			traceId: entry.traceId,
			id: spanId,
			ts: endTime.toISOString()
		}, source)) return;
		if (!beginSdkEnqueue(entry, spanId, "span-update", `${source} span update`)) return;
		span.update({
			endTime,
			output: redactObject(truncatePayload(output), redactToolPayloads),
			metadata: {
				toolName,
				toolCallId,
				source,
				...isError ? { isError: true } : {}
			},
			...isError ? {
				level: "ERROR",
				statusMessage: "tool returned an error result"
			} : {}
		});
		entry.pendingSpans.delete(toolCallId);
		(entry.completedSpans ??= /* @__PURE__ */ new Map()).set(toolCallId, span);
		entry.completedSpanToolCallIds.add(toolCallId);
	}
	function recordTranscriptToolCalls(entry, update, msg, redactEnabledForUpdate, persistedAssistantCompletionTime) {
		if (shouldDeferCodexTranscriptToolSpans(entry)) return;
		const content = msg.content;
		if (!Array.isArray(content)) return;
		const startTime = persistedAssistantCompletionTime ?? timestampToDate(msg.timestamp) ?? /* @__PURE__ */ new Date();
		for (const block of content) {
			if (!isToolCallBlock(block) || typeof block.id !== "string") continue;
			const toolName = String(block.name ?? "unknown");
			createTranscriptToolSpan({
				entry,
				agentId: update.agentId,
				sessionId: update.sessionId,
				toolCallId: block.id,
				toolName,
				input: block.input ?? block.args ?? block.arguments ?? {},
				startTime,
				redactEnabled: redactEnabledForUpdate,
				source: "transcript-tool-call"
			});
		}
	}
	function recordTranscriptToolResult(entry, update, msg, redactEnabledForUpdate, persistedCompletionTime) {
		if (shouldDeferCodexTranscriptToolSpans(entry)) return;
		const toolCallId = transcriptToolResultId(msg);
		if (!toolCallId) return;
		completeTranscriptToolSpan({
			entry,
			agentId: update.agentId,
			sessionId: update.sessionId,
			toolCallId,
			toolName: typeof msg.toolName === "string" ? msg.toolName : "unknown",
			output: transcriptToolResultOutput(msg),
			endTime: persistedCompletionTime ?? timestampToDate(msg.timestamp) ?? /* @__PURE__ */ new Date(),
			redactEnabled: redactEnabledForUpdate,
			source: "transcript-tool-result",
			isError: msg.isError === true
		});
		patchFinalizedTraceFromTranscript(entry, redactEnabledForUpdate);
	}
	function applyDeferredProviderRequestCompletion(entry, generationIndex, generation) {
		const deferred = entry.deferredProviderRequestCompletions?.get(generationIndex);
		if (!deferred) return;
		if (!beginSdkEnqueue(entry, entry.completedGenerationIds?.get(generationIndex) ?? generateObservationId(entry.traceId, "gen", generationIndex), "generation-update", "provider-request deferred generation update")) return;
		generation.update({
			...deferred.startTime ? { startTime: deferred.startTime } : {},
			endTime: deferred.endTime,
			...deferred.input !== void 0 ? { input: deferred.input } : {},
			...deferred.output !== void 0 ? { output: deferred.output } : {},
			...deferred.usageDetails ? { usageDetails: deferred.usageDetails } : {},
			...deferred.level ? { level: deferred.level } : {},
			...deferred.statusMessage ? { statusMessage: deferred.statusMessage } : {},
			metadata: {
				...deferred.metadata,
				source: "provider-request-deferred"
			}
		});
		entry.deferredProviderRequestCompletions?.delete(generationIndex);
	}
	function applyDeferredProviderRequestCompletions(entry) {
		for (const [generationIndex, generation] of entry.completedGenerations) applyDeferredProviderRequestCompletion(entry, generationIndex, generation);
	}
	function isCurrentTranscriptEntry(sessionKey, entry, ownership) {
		const currentContextMap = contextMap;
		if (disabled || !tracingEnabled || langfuse === null || !currentContextMap) return false;
		if (ownership === "persisted") return currentContextMap.findRecent(sessionKey, { traceId: entry.traceId }) === entry;
		if (ownership === "active") return currentContextMap.findActive(sessionKey) === entry;
		return currentContextMap.findActive(sessionKey) === void 0 && currentContextMap.findRecent(sessionKey, { traceId: entry.traceId }) === entry;
	}
	async function handleTranscriptUpdate(update, _redactEnabled) {
		if (disabled || !tracingEnabled || !langfuse || !contextMap) return;
		const msg = update.message;
		if (!msg || typeof msg !== "object") return;
		const role = msg.role;
		if (!role) return;
		const transcriptAgentId = update.agentId;
		const transcriptSessionId = update.sessionId;
		const sessionKey = update.sessionKey;
		const canRepairLateTranscript = role === "assistant" || role === "toolResult" || role === "tool";
		const persistedTraceId = persistedLangfuseTraceId(msg);
		const initialOwnedEntry = persistedTraceId ? contextMap.findRecent(sessionKey, { traceId: persistedTraceId }) : void 0;
		if (persistedTraceId && !initialOwnedEntry) return;
		const initialActiveEntry = persistedTraceId ? initialOwnedEntry && !initialOwnedEntry.finalized ? initialOwnedEntry : void 0 : contextMap.findActive(sessionKey);
		let preloadedTranscriptEntries;
		let transcriptBoundaryTime = timestampToDate(msg.timestamp);
		const hasPersistedIdentity = Boolean(update.messageId || update.messageSeq !== void 0);
		if (!transcriptBoundaryTime && hasPersistedIdentity && (!persistedTraceId && !initialActiveEntry && canRepairLateTranscript || (role === "toolResult" || role === "tool") && Boolean(initialActiveEntry))) {
			preloadedTranscriptEntries = await readTranscriptEntriesForUpdate(update);
			transcriptBoundaryTime = persistedEntryTimestampToDate(findPersistedTranscriptEntry(update, preloadedTranscriptEntries)?.timestamp);
		}
		if (disabled || !tracingEnabled || !langfuse || !contextMap) return;
		const ownedEntry = persistedTraceId ? contextMap.findRecent(sessionKey, { traceId: persistedTraceId }) : void 0;
		if (persistedTraceId && !ownedEntry) return;
		const activeEntry = persistedTraceId ? ownedEntry && !ownedEntry.finalized ? ownedEntry : void 0 : initialActiveEntry;
		const recentFinalizedEntry = !persistedTraceId && !initialActiveEntry && canRepairLateTranscript && transcriptBoundaryTime ? contextMap.findRecentFinalized(sessionKey, (candidate) => isWithinFinalizedTraceTimeBoundary(transcriptBoundaryTime, candidate)) : void 0;
		const entry = ownedEntry ?? activeEntry ?? recentFinalizedEntry;
		const entryOwnership = persistedTraceId ? "persisted" : entry === activeEntry ? "active" : "finalized";
		const isInitiallyLateFinalizedTranscript = Boolean(entry?.finalized) && canRepairLateTranscript;
		if (!entry || entry.deliveryFinalized || entry.finalized && !isInitiallyLateFinalizedTranscript) return;
		if (role === "assistant") {
			if (isTranscriptOnlyAssistantMessage(msg)) {
				if (typeof msg.provider === "string") entry.lastProvider = msg.provider;
				const transcriptTiming = await resolveTranscriptTiming(update, entry, msg, preloadedTranscriptEntries);
				if (!isCurrentTranscriptEntry(sessionKey, entry, entryOwnership)) return;
				recordTranscriptToolCalls(entry, update, msg, _redactEnabled, transcriptTiming.endTime);
				patchFinalizedTraceFromTranscript(entry, _redactEnabled);
				serviceLogger?.debug?.("Langfuse: skipping transcript-only assistant row");
				return;
			}
			const transcriptTiming = await resolveTranscriptTiming(update, entry, msg, preloadedTranscriptEntries);
			if (!isCurrentTranscriptEntry(sessionKey, entry, entryOwnership)) {
				serviceLogger?.debug?.(`Langfuse: skipping transcript update after trace replacement (traceId=${entry.traceId})`);
				return;
			}
			const isLateFinalizedAssistant = entry.finalized;
			recordTranscriptToolCalls(entry, update, msg, _redactEnabled, transcriptTiming.endTime);
			const usage = msg.usage;
			const model = msg.model;
			const provider = msg.provider;
			const stopReason = msg.stopReason;
			serviceLogger?.info?.(`Langfuse: transcript assistant msg — model=${model ?? "?"} stopReason=${stopReason ?? "?"} hasUsage=${Boolean(usage)}`);
			if (usage) entry.storedUsage = {
				input: usage.input ?? void 0,
				output: usage.output ?? void 0,
				cacheRead: usage.cacheRead ?? void 0,
				cacheWrite: usage.cacheWrite ?? void 0,
				total: usage.totalTokens ?? usage.total ?? void 0
			};
			if (msg.content) {
				const texts = (Array.isArray(msg.content) ? msg.content : [msg.content]).filter((b) => Boolean(b) && typeof b === "object" && b.type === "text").map((b) => b.text);
				if (texts.length > 0) entry.storedOutput = texts.join("\n");
			}
			if (model) entry.lastModel = model;
			if (provider) entry.lastProvider = provider;
			const usageDetails = usageDetailsFromUsage(normalizeTranscriptUsage(usage));
			const generationOutput = msg.content ? truncatePayload(buildGenerationOutput(msg.content, _redactEnabled)) : void 0;
			const completedGenIndex = transcriptTiming.assistantCallIndex ?? entry.llmCallCount;
			const completedGen = transcriptTiming.assistantCallIndex !== void 0 ? entry.completedGenerations.get(transcriptTiming.assistantCallIndex) : entry.completedGenerations.size >= entry.llmCallCount && entry.llmCallCount > 0 ? entry.completedGenerations.get(entry.llmCallCount) ?? [...entry.completedGenerations.values()].at(-1) : void 0;
			if (entry.hasProviderRequestGenerations || entry.providerRequestAugmentedHookGenerations) {
				const providerGenerationIndex = transcriptTiming.assistantCallIndex ?? (entry.completedGenerations.size === 1 ? entry.completedGenerations.keys().next().value : void 0);
				const providerGeneration = providerGenerationIndex !== void 0 ? entry.completedGenerations.get(providerGenerationIndex) : void 0;
				if (providerGeneration && providerGenerationIndex !== void 0 && generationOutput !== void 0 && entry.providerRequestGenerationOutputMissing?.has(providerGenerationIndex)) {
					if (beginSdkEnqueue(entry, entry.completedGenerationIds?.get(providerGenerationIndex) ?? generateObservationId(entry.traceId, "gen", providerGenerationIndex), "generation-update", "transcript provider generation output update")) {
						providerGeneration.update({ output: generationOutput });
						entry.providerRequestGenerationOutputMissing.delete(providerGenerationIndex);
					}
				}
				patchFinalizedTraceFromTranscript(entry, _redactEnabled);
				return;
			}
			if (completedGen && completedGenIndex > 0) {
				if (!beginSdkEnqueue(entry, entry.completedGenerationIds?.get(completedGenIndex) ?? generateObservationId(entry.traceId, "gen", completedGenIndex), "generation-update", "transcript completed generation update")) return;
				completedGen.update({
					...completedGenIndex > 1 && transcriptTiming.startTime ? { startTime: transcriptTiming.startTime } : {},
					...transcriptTiming.endTime ? { endTime: transcriptTiming.endTime } : {},
					...generationOutput !== void 0 ? { output: generationOutput } : {},
					...usageDetails ? { usageDetails } : {},
					metadata: {
						provider,
						model,
						stopReason,
						source: isLateFinalizedAssistant ? "late-transcript-repair" : "transcript-realtime"
					}
				});
				entry.llmCallCount = Math.max(entry.llmCallCount, completedGenIndex);
				applyDeferredProviderRequestCompletion(entry, completedGenIndex, completedGen);
				if (transcriptTiming.endTime) entry.lastGenerationEndTime = transcriptTiming.endTime;
				patchFinalizedTraceFromTranscript(entry, _redactEnabled);
				return;
			}
			const pendingEntry = [...entry.pendingGenerations.entries()][0];
			if (pendingEntry) {
				const [runId, pendingGen] = pendingEntry;
				const endTime = transcriptTiming.endTime ?? /* @__PURE__ */ new Date();
				const pendingGenId = entry.pendingGenIds.get(runId);
				if (pendingGenId && !appendObservationEventOrMark(entry, transcriptAgentId, transcriptSessionId, {
					e: "gen-end",
					traceId: entry.traceId,
					id: pendingGenId,
					ts: endTime.toISOString()
				}, "transcript-realtime")) return;
				if (!beginSdkEnqueue(entry, pendingGenId ?? entry.traceId, "generation-update", "transcript pending generation update")) return;
				pendingGen.update({
					...completedGenIndex > 1 && transcriptTiming.startTime ? { startTime: transcriptTiming.startTime } : {},
					endTime,
					...generationOutput !== void 0 ? { output: generationOutput } : {},
					...usageDetails ? { usageDetails } : {},
					metadata: {
						provider,
						model,
						stopReason,
						source: isLateFinalizedAssistant ? "late-transcript-repair" : "transcript-realtime"
					}
				});
				entry.pendingGenerations.delete(runId);
				const resolvedGenIndex = completedGenIndex > 0 ? completedGenIndex : entry.llmCallCount;
				entry.completedGenerations.set(resolvedGenIndex, pendingGen);
				if (pendingGenId) (entry.completedGenerationIds ??= /* @__PURE__ */ new Map()).set(resolvedGenIndex, pendingGenId);
				entry.pendingGenIds.delete(runId);
				applyDeferredProviderRequestCompletion(entry, resolvedGenIndex, pendingGen);
				entry.llmCallCount = Math.max(entry.llmCallCount, resolvedGenIndex);
				entry.lastGenerationEndTime = endTime;
				patchFinalizedTraceFromTranscript(entry, _redactEnabled);
				serviceLogger?.debug?.(`Langfuse: transcript completed pending generation (llmCall=${resolvedGenIndex})`);
			} else {
				if (isLateFinalizedAssistant && !transcriptTiming.assistantCallIndex) {
					patchFinalizedTraceFromTranscript(entry, _redactEnabled);
					return;
				}
				if (entry.hasProviderRequestGenerations) {
					patchFinalizedTraceFromTranscript(entry, _redactEnabled);
					return;
				}
				const nextLlmCall = transcriptTiming.assistantCallIndex && transcriptTiming.assistantCallIndex > 0 ? transcriptTiming.assistantCallIndex : entry.llmCallCount + 1;
				if (entry.completedGenerations.has(nextLlmCall)) {
					patchFinalizedTraceFromTranscript(entry, _redactEnabled);
					return;
				}
				entry.llmCallCount = Math.max(entry.llmCallCount, nextLlmCall);
				const genId = generateObservationId(entry.traceId, "gen", nextLlmCall);
				const qualModel = model ? qualifiedModel(provider ?? "", model) : entry.lastModel ?? "unknown";
				const endTime = transcriptTiming.endTime ?? /* @__PURE__ */ new Date();
				const startTime = startTimeBeforeEnd(transcriptTiming.startTime, endTime) ?? (entry.lastGenerationEndTime && entry.lastGenerationEndTime.getTime() <= endTime.getTime() ? entry.lastGenerationEndTime : endTime);
				if (!appendObservationEventOrMark(entry, transcriptAgentId, transcriptSessionId, {
					e: "gen-start",
					traceId: entry.traceId,
					id: genId,
					llmCall: nextLlmCall,
					model: qualModel,
					ts: startTime.toISOString()
				}, "transcript-realtime")) return;
				if (!appendObservationEventOrMark(entry, transcriptAgentId, transcriptSessionId, {
					e: "gen-end",
					traceId: entry.traceId,
					id: genId,
					ts: endTime.toISOString()
				}, "transcript-realtime")) return;
				if (!beginSdkReconstructionEnqueue(entry, genId, "generation-create", "transcript generation")) return;
				const generation = entry.trace.generation({
					id: genId,
					name: `llm-call-${nextLlmCall}`,
					model: qualModel,
					startTime,
					endTime,
					...generationOutput !== void 0 ? { output: generationOutput } : {},
					...entry.currentGenerationId ? { parentObservationId: entry.currentGenerationId } : {},
					metadata: {
						provider,
						model,
						stopReason,
						source: isLateFinalizedAssistant ? "late-transcript-repair" : "transcript-realtime"
					},
					...usageDetails ? { usageDetails } : {}
				});
				entry.completedGenerations.set(nextLlmCall, generation);
				(entry.completedGenerationIds ??= /* @__PURE__ */ new Map()).set(nextLlmCall, genId);
				applyDeferredProviderRequestCompletion(entry, nextLlmCall, generation);
				entry.currentGenerationId = genId;
				entry.lastGenerationEndTime = endTime;
				patchFinalizedTraceFromTranscript(entry, _redactEnabled);
				serviceLogger?.info?.(`Langfuse: transcript created intermediate generation ${genId} (llmCall=${nextLlmCall})`);
			}
		}
		if (role === "toolResult" || role === "tool") {
			if (!isCurrentTranscriptEntry(sessionKey, entry, entryOwnership)) return;
			recordTranscriptToolResult(entry, update, msg, _redactEnabled, transcriptBoundaryTime);
		}
	}
	return {
		id: "openclaw-langfuse",
		async start(ctx) {
			const runtimeEvents = pluginRuntime?.events ?? null;
			if (langfuse && runtimeEvents === activeRuntimeEvents && contextMap?.hasActiveEntries()) {
				ctx.logger.warn("Langfuse: duplicate service start ignored while traces are active");
				return;
			}
			serviceLogger = ctx.logger;
			serviceStateDir = ctx.stateDir ?? null;
			if (pluginRuntime?.state?.openSyncKeyedStore) try {
				const ledgerEnv = serviceStateDir ? {
					...process.env,
					OPENCLAW_STATE_DIR: serviceStateDir
				} : process.env;
				configureTraceLedgerStore(serviceStateDir, pluginRuntime.state.openSyncKeyedStore({
					namespace: TRACE_LEDGER_NAMESPACE,
					maxEntries: TRACE_LEDGER_MAX_ENTRIES,
					overflowPolicy: "evict-oldest",
					defaultTtlMs: TRACE_LEDGER_TTL_MS,
					env: ledgerEnv
				}));
			} catch (error) {
				serviceLogger.warn(`Langfuse: plugin-state trace ledger unavailable; durable recovery is disabled for this process — ${String(error)}`);
			}
			activeServiceOwner = serviceOwner;
			ownsActiveRuntime = true;
			await cleanupRuntimeState();
			internalDiagnosticDelivery = internalDiagnosticDeliveryFromContext(ctx);
			const { publicKey, secretKey, baseUrl } = resolveCredentials(config);
			if (!publicKey || !secretKey) {
				ctx.logger.warn("Langfuse plugin: missing publicKey or secretKey — tracing disabled. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars or configure them in pluginConfig.");
				disabled = true;
				return;
			}
			langfuse = new Langfuse({
				publicKey,
				secretKey,
				baseUrl,
				flushAt: 5,
				flushInterval: 1e3,
				requestTimeout: 3e4,
				fetchRetryCount: 2,
				fetchRetryDelay: 2e3
			});
			sdkEventCleanups.push(...bindSdkDeliveryTracker(langfuse, sdkDeliveryTracker, ctx.logger));
			contextMap = new TraceContextMap((entry) => {
				sdkDeliveryTracker.completeTrace(entry.traceId);
				for (const observation of entry.nativeChildLineage?.observations.values() ?? []) sdkDeliveryTracker.completeTrace(observation.traceEntry.traceId);
			});
			contextMap.startSweep();
			activeRuntimeEvents = runtimeEvents;
			disabled = false;
			promptManager = config.prompts?.length ? new PromptManager(langfuse, config) : null;
			if (promptManager) promptManager.warmCache().then(() => {
				ctx.logger.info(`Langfuse: prompt cache warmed (${config.prompts?.length ?? 0} rules)`);
			}).catch((err) => {
				ctx.logger.warn(`Langfuse: warmCache failed: ${err}`);
			});
			trackRuntimeTask((async () => {
				try {
					if (!tracingEnabled || !serviceStateDir) return;
					const incompleteTraces = scanIncompleteTraces(serviceStateDir, serviceLogger);
					if (incompleteTraces.length === 0) return;
					serviceLogger?.info?.(`Langfuse: recovering ${incompleteTraces.length} incomplete trace(s)`);
					for (const traceInfo of incompleteTraces) {
						const recoveryAttempt = (traceInfo.recoveryAttempts ?? 0) + 1;
						if (!writeTraceRecoveryMarker(serviceStateDir, traceInfo.agentId, traceInfo.sessionId, traceInfo.traceId, recoveryAttempt, "started", serviceLogger)) {
							serviceLogger?.warn?.(`Langfuse: skipped recovery for trace ${traceInfo.traceId}; recovery attempt could not be persisted`);
							continue;
						}
						try {
							const count = await recoverTrace(langfuse, traceInfo, {
								redactEnabled,
								baseUrl
							}, serviceStateDir, serviceLogger, sdkDeliveryTracker);
							writeTraceRecoveryMarker(serviceStateDir, traceInfo.agentId, traceInfo.sessionId, traceInfo.traceId, recoveryAttempt, "succeeded", serviceLogger);
							serviceLogger?.info?.(`Langfuse: recovered trace ${traceInfo.traceId} (${count} observations)`);
						} catch (err) {
							writeTraceRecoveryMarker(serviceStateDir, traceInfo.agentId, traceInfo.sessionId, traceInfo.traceId, recoveryAttempt, "failed", serviceLogger);
							if (recoveryAttempt >= 3) writeTraceRecoveryMarker(serviceStateDir, traceInfo.agentId, traceInfo.sessionId, traceInfo.traceId, recoveryAttempt, "abandoned", serviceLogger, "attempt_limit_reached");
							serviceLogger?.warn?.(`Langfuse: failed to recover trace ${traceInfo.traceId}: ${err}`);
						}
					}
				} catch (err) {
					serviceLogger?.warn?.(`Langfuse: trace recovery scan failed: ${err}`);
				}
			})());
			if (tracingEnabled && langfuse && contextMap) unsubscribeDiagnostics = await subscribeDiagnosticEvents({
				langfuse,
				contextMap,
				logger: serviceLogger,
				stateDir: serviceStateDir,
				redactEnabled,
				config,
				promptManager,
				internalDiagnostics: ctx.internalDiagnostics,
				onBeforeSdkEnqueue: (traceId, observationId, eventType, source) => {
					const entry = contextMap?.findRecent(void 0, { traceId });
					if (!entry) return sdkDeliveryTracker.begin(traceId, observationId, eventType);
					return beginSdkEnqueue(entry, observationId, eventType, source);
				},
				onDiagnosticTask: trackDiagnosticTask,
				onNativeChildDiagnostic: handleNativeChildDiagnostic,
				onNativeChildDiagnosticBatchComplete: finalizePendingNativeChildObservations,
				onNativeChildPostFinalization: (entry) => {
					noteNativeChildProducerUnhealthy(entry);
				},
				resolveNativeChildParent: (entry, childThreadId, childTurnId, timestamp, source) => (() => {
					const state = nativeChildLineage(entry);
					const observation = ensureNativeChildObservation({
						entry,
						childThreadId,
						childTurnId,
						timestamp,
						metadata: {
							childThreadId,
							childTurnId,
							lifecycle: "owned_call_activity",
							triggeringToolCallId: state.childTriggeringToolCallIds.get(childThreadId)
						},
						source
					});
					if (observation) {
						const pendingLifecycleEvents = state.pendingLifecycleEvents.get(childThreadId) ?? [];
						state.pendingLifecycleEvents.delete(childThreadId);
						clearNativeChildPending(entry, childThreadId);
						for (const pendingEvent of pendingLifecycleEvents) updateNativeChildObservation(entry, observation, pendingEvent);
					}
					return observation;
				})(),
				onTraceFinalized: async (entry, agentId, sessionId) => {
					if (entry.deliveryFinalized || entry.finalizationInProgress) return;
					finalizeNativeChildLineage(entry, true);
					const metadata = {
						...entry.traceMetadata,
						nativeChildLineage: nativeChildLineageMetadata(entry)
					};
					entry.traceMetadata = metadata;
					if (beginSdkEnqueue(entry, entry.traceId, "trace-create", "diagnostic native-child metadata")) entry.trace.update({ metadata });
					entry.finalizationInProgress = true;
					try {
						await closeTranscriptAdmissionAndDrain(entry, typeof entry.traceMetadata?.sessionKey === "string" ? entry.traceMetadata.sessionKey : void 0, "diagnostic finalization");
						await finalizeTraceDelivery(entry, agentId, sessionId, "diagnostic finalization");
					} finally {
						completeTraceFinalization(entry);
					}
				}
			});
			if (tracingEnabled && langfuse && contextMap && pluginRuntime?.events?.onSessionTranscriptUpdate) {
				unsubscribeTranscript = pluginRuntime.events.onSessionTranscriptUpdate((update) => {
					const normalizedUpdate = normalizeTranscriptUpdate(update);
					if (!normalizedUpdate) {
						serviceLogger?.debug?.("Langfuse: skipped transcript update without session identity");
						return;
					}
					const currentEntry = transcriptAdmissionEntry(normalizedUpdate);
					if (currentEntry?.deliveryFinalized || currentEntry?.transcriptAdmissionClosed) return;
					if (!enqueueTranscriptTask(normalizedUpdate.sessionKey, estimateTranscriptUpdateBytes(normalizedUpdate), async () => {
						try {
							await handleTranscriptUpdate(normalizedUpdate, redactEnabled);
						} catch (error) {
							serviceLogger?.warn?.(`Langfuse: transcript update failed — ${String(error)}`);
						}
					})) {
						if (currentEntry) markObservationBarrierFailed(currentEntry, "transcript_queue_drop", "transcript", 1);
					}
				});
				ctx.logger.info("Langfuse: subscribed to onSessionTranscriptUpdate");
			}
			ctx.logger.info(`Langfuse plugin initialized (${baseUrl})`);
		},
		async stop(_ctx) {
			if (!ownsActiveRuntime || activeServiceOwner !== serviceOwner) return;
			ownsActiveRuntime = false;
			activeServiceOwner = null;
			pendingPromptStates.clear();
			await cleanupRuntimeState();
		},
		getHookHandlers() {
			return handlers;
		}
	};
}
//#endregion
//#region extensions/openclaw-langfuse/index.ts
var openclaw_langfuse_default = definePluginEntry({
	id: "openclaw-langfuse",
	name: "Langfuse",
	description: "Langfuse tracing and prompt management for OpenClaw",
	register(api) {
		const config = api.pluginConfig ?? {};
		if (!Boolean(process.env["LANGFUSE_PUBLIC_KEY"] || process.env["LANGFUSE_SECRET_KEY"]) && !config.baseUrl && !config.publicKey && !config.secretKey && !config.tracing && !config.prompts) return;
		const service = createLangfuseService(config, api.logger, api.runtime);
		api.registerService(service);
		const h = service.getHookHandlers();
		api.on("before_prompt_build", h.beforePromptBuild);
		api.on("before_agent_run", h.beforeAgentRun);
		api.on("llm_input", h.llmInput);
		api.on("llm_output", h.llmOutput);
		api.on("before_tool_call", h.beforeToolCall);
		api.on("after_tool_call", h.afterToolCall);
		api.on("agent_end", h.agentEnd);
		api.on("session_start", h.sessionStart);
		api.on("session_end", h.sessionEnd);
		api.on("before_message_write", h.beforeMessageWrite);
		api.logger.info(`Langfuse: hooks registered (config keys: ${Object.keys(config).join(",")})`);
	}
});
//#endregion
export { openclaw_langfuse_default as default };
