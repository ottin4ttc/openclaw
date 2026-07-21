#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CUSTOM_TOOL_ARGUMENT_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CUSTOM_TOOL_ARGUMENT_BYTES = 8 * 1024 * 1024;
const MAX_REASONING_BYTES = 64 * 1024;
const MAX_REASONING_STORE_BYTES = 8 * 1024 * 1024;
const MAX_INTERNAL_ERROR_ATTEMPTS = 100;
const MAX_REMEMBERED_REASONING_CALLS = 2048;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const REASONING_TTL_MS = 30 * 60 * 1000;

function createWireToolName(kind, namespace, name, occupiedNames) {
  const digest = createHash("sha256")
    .update(`${kind}\0${namespace || ""}\0${name}`)
    .digest("hex");
  for (let length = 16; length <= digest.length; length += 4) {
    const candidate = `oc_${kind === "custom" ? "c" : "n"}_${digest.slice(0, length)}`;
    if (!occupiedNames.has(candidate)) {
      occupiedNames.add(candidate);
      return candidate;
    }
  }
  throw new Error(`cannot allocate a collision-free wire name for ${kind} tool ${name}`);
}

function normalizeFunctionTool(tool, descriptionPrefix) {
  const next = { ...tool, type: "function" };
  if (descriptionPrefix && typeof next.description === "string" && next.description.trim()) {
    next.description = `${descriptionPrefix}\n\n${next.description}`;
  }
  delete next.defer_loading;
  return next;
}

function findWireToolName(flatToolMap, kind, namespace, name) {
  for (const [wireName, original] of flatToolMap) {
    if (original.kind === kind && original.namespace === namespace && original.name === name) {
      return wireName;
    }
  }
  return undefined;
}

function findUniqueWireToolName(flatToolMap, kind, namespace, name) {
  const exact = findWireToolName(flatToolMap, kind, namespace, name);
  if (exact || namespace !== undefined) {
    return exact;
  }

  let match;
  for (const [wireName, original] of flatToolMap) {
    if (original.kind !== kind || original.name !== name) {
      continue;
    }
    if (match) {
      return undefined;
    }
    match = wireName;
  }
  return match;
}

function rewriteToolChoiceReference(reference, flatToolMap) {
  if (!reference || typeof reference !== "object" || typeof reference.name !== "string") {
    return reference;
  }

  const namespace = typeof reference.namespace === "string" ? reference.namespace : undefined;
  if (reference.type === "custom") {
    const wireName = findUniqueWireToolName(flatToolMap, "custom", namespace, reference.name);
    return wireName ? { type: "function", name: wireName } : reference;
  }

  if (reference.type === "function" && namespace !== undefined) {
    const wireName = findWireToolName(flatToolMap, "namespace", namespace, reference.name);
    return wireName ? { type: "function", name: wireName } : reference;
  }

  return reference;
}

function transformToolChoice(toolChoice, flatToolMap) {
  if (!toolChoice || typeof toolChoice !== "object") {
    return toolChoice;
  }

  if (toolChoice.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    return {
      ...toolChoice,
      tools: toolChoice.tools.map((tool) => rewriteToolChoiceReference(tool, flatToolMap)),
    };
  }

  return rewriteToolChoiceReference(toolChoice, flatToolMap);
}

function transformInputItem(item, flatToolMap) {
  if (!item || typeof item !== "object") {
    return item;
  }
  if (item.type === "custom_tool_call" && typeof item.name === "string") {
    const namespace = typeof item.namespace === "string" ? item.namespace : undefined;
    const wireName = findWireToolName(flatToolMap, "custom", namespace, item.name);
    if (!wireName) {
      return item;
    }
    const { input, namespace: _namespace, status: _status, ...rest } = item;
    return {
      ...rest,
      type: "function_call",
      name: wireName,
      arguments: JSON.stringify({ input }),
    };
  }
  if (item.type === "custom_tool_call_output") {
    const { name: _name, ...rest } = item;
    return { ...rest, type: "function_call_output" };
  }
  if (
    item.type === "function_call" &&
    typeof item.namespace === "string" &&
    typeof item.name === "string"
  ) {
    const wireName = findWireToolName(flatToolMap, "namespace", item.namespace, item.name);
    if (!wireName) {
      return item;
    }
    const { namespace: _namespace, ...rest } = item;
    return { ...rest, name: wireName };
  }
  return item;
}

function keepFunctionCallOutputsAdjacent(input) {
  const reordered = [];
  const movedOutputIndexes = new Set();

  for (let index = 0; index < input.length;) {
    if (movedOutputIndexes.has(index)) {
      index += 1;
      continue;
    }

    const item = input[index];
    if (item?.type !== "function_call" || typeof item.call_id !== "string") {
      reordered.push(item);
      index += 1;
      continue;
    }

    let callEnd = index;
    const callIds = [];
    while (input[callEnd]?.type === "function_call" && typeof input[callEnd].call_id === "string") {
      callIds.push(input[callEnd].call_id);
      callEnd += 1;
    }

    const pendingCallIds = new Set(callIds);
    const matchingOutputs = [];
    for (let outputIndex = callEnd; outputIndex < input.length; outputIndex += 1) {
      const candidate = input[outputIndex];
      if (
        candidate?.type === "function_call" ||
        (candidate?.type === "message" && candidate.role !== "assistant")
      ) {
        break;
      }
      if (
        candidate?.type === "function_call_output" &&
        typeof candidate.call_id === "string" &&
        pendingCallIds.delete(candidate.call_id)
      ) {
        matchingOutputs.push([outputIndex, candidate]);
      }
      if (pendingCallIds.size === 0) {
        break;
      }
    }

    for (let callIndex = index; callIndex < callEnd; callIndex += 1) {
      reordered.push(input[callIndex]);
    }
    // LiteLLM converts consecutive Responses calls into one Chat assistant message.
    // Its matching tool messages must be adjacent or the Chat request is rejected.
    if (pendingCallIds.size === 0) {
      for (const [outputIndex, output] of matchingOutputs) {
        reordered.push(output);
        movedOutputIndexes.add(outputIndex);
      }
    }
    index = callEnd;
  }

  return reordered;
}

function coalesceFunctionCallOutputs(input) {
  const coalesced = [];
  const outputIndexByCallId = new Map();

  for (const item of input) {
    if (
      item?.type !== "function_call_output" ||
      typeof item.call_id !== "string" ||
      typeof item.output !== "string"
    ) {
      coalesced.push(item);
      continue;
    }

    const existingIndex = outputIndexByCallId.get(item.call_id);
    if (existingIndex === undefined) {
      outputIndexByCallId.set(item.call_id, coalesced.length);
      coalesced.push(item);
      continue;
    }

    const existing = coalesced[existingIndex];
    coalesced[existingIndex] = {
      ...existing,
      output: `${existing.output}\n${item.output}`,
    };
  }

  return coalesced;
}

function reasoningTextFromItem(item) {
  const parts = item?.summary ?? item?.content;
  if (typeof parts === "string") {
    return parts;
  }
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function reasoningStoreKey(clientIdentity, promptCacheKey, model, callId) {
  return `${clientIdentity}\0${promptCacheKey}\0${typeof model === "string" ? model : ""}\0${callId}`;
}

function pruneReasoningStore(reasoningByCallId, now = Date.now()) {
  for (const [key, entry] of reasoningByCallId) {
    if (entry.expiresAt <= now) {
      reasoningByCallId.delete(key);
    }
  }

  let totalBytes = 0;
  for (const entry of reasoningByCallId.values()) {
    totalBytes += entry.bytes;
  }
  while (
    reasoningByCallId.size > MAX_REMEMBERED_REASONING_CALLS ||
    totalBytes > MAX_REASONING_STORE_BYTES
  ) {
    const oldestKey = reasoningByCallId.keys().next().value;
    const oldest = reasoningByCallId.get(oldestKey);
    reasoningByCallId.delete(oldestKey);
    totalBytes -= oldest?.bytes ?? 0;
  }
}

function setCurrentReasoning(state, reasoning) {
  const normalized = reasoning.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > MAX_REASONING_BYTES) {
    state.currentReasoning = "";
    state.reasoningOverflow = Boolean(normalized);
    return;
  }
  state.currentReasoning = normalized;
  state.reasoningOverflow = false;
}

function appendReasoningDelta(state, field, delta) {
  if (state.reasoningOverflow) {
    return undefined;
  }
  const next = `${state[field] ?? ""}${delta}`;
  if (Buffer.byteLength(next, "utf8") > MAX_REASONING_BYTES) {
    state[field] = "";
    state.currentReasoning = "";
    state.reasoningOverflow = true;
    return undefined;
  }
  state[field] = next;
  return next;
}

function rememberReasoningForCall(state, item) {
  const callId = item?.call_id ?? item?.id;
  const reasoning = state?.currentReasoning?.trim();
  if (
    typeof callId !== "string" ||
    !callId ||
    !reasoning ||
    state.reasoningOverflow ||
    !state.reasoningByCallId ||
    typeof state.promptCacheKey !== "string" ||
    !state.promptCacheKey
  ) {
    return;
  }

  const bytes = Buffer.byteLength(reasoning, "utf8");
  const key = reasoningStoreKey(
    state.clientIdentity ?? "anonymous",
    state.promptCacheKey,
    state.model,
    callId,
  );
  state.reasoningByCallId.delete(key);
  state.reasoningByCallId.set(key, {
    text: reasoning,
    bytes,
    expiresAt: Date.now() + REASONING_TTL_MS,
  });
  pruneReasoningStore(state.reasoningByCallId);
}

function observeResponseItems(items, state) {
  if (!Array.isArray(items) || !state) {
    return;
  }
  for (const item of items) {
    if (item?.type === "reasoning") {
      const reasoning = reasoningTextFromItem(item);
      if (reasoning) {
        setCurrentReasoning(state, reasoning);
      }
      continue;
    }
    if (item?.type === "function_call") {
      rememberReasoningForCall(state, item);
    }
  }
}

function observeResponseValue(value, state) {
  if (!value || typeof value !== "object" || !state) {
    return;
  }
  if (value.type === "response.reasoning_summary_text.delta" && typeof value.delta === "string") {
    const reasoning = appendReasoningDelta(state, "reasoningSummary", value.delta);
    if (reasoning) {
      state.currentReasoning = reasoning;
    }
  } else if (value.type === "response.reasoning_text.delta" && typeof value.delta === "string") {
    const reasoning = appendReasoningDelta(state, "reasoningContent", value.delta);
    if (reasoning && !state.reasoningSummary) {
      state.currentReasoning = reasoning;
    }
  }

  const item = value.item;
  if (item?.type === "reasoning") {
    const reasoning = reasoningTextFromItem(item);
    if (reasoning) {
      setCurrentReasoning(state, reasoning);
    }
  } else if (item?.type === "function_call") {
    rememberReasoningForCall(state, item);
  }

  observeResponseItems(value.output, state);
  observeResponseItems(value.response?.output, state);
}

function injectRememberedReasoning(
  input,
  reasoningByCallId,
  clientIdentity,
  promptCacheKey,
  model,
) {
  if (!reasoningByCallId?.size || typeof promptCacheKey !== "string" || !promptCacheKey) {
    return input;
  }
  pruneReasoningStore(reasoningByCallId);

  const injected = [];
  for (let index = 0; index < input.length;) {
    const item = input[index];
    if (item?.type !== "function_call") {
      injected.push(item);
      index += 1;
      continue;
    }

    let callEnd = index;
    let rememberedReasoning = "";
    while (input[callEnd]?.type === "function_call") {
      const callId = input[callEnd].call_id ?? input[callEnd].id;
      if (!rememberedReasoning && typeof callId === "string") {
        rememberedReasoning =
          reasoningByCallId.get(reasoningStoreKey(clientIdentity, promptCacheKey, model, callId))
            ?.text ?? "";
      }
      callEnd += 1;
    }

    const previousItem = injected.at(-1);
    const hasReasoning =
      previousItem?.type === "reasoning" && Boolean(reasoningTextFromItem(previousItem));
    if (!hasReasoning && rememberedReasoning) {
      injected.push({
        type: "reasoning",
        summary: [{ type: "summary_text", text: rememberedReasoning }],
      });
    }
    for (let callIndex = index; callIndex < callEnd; callIndex += 1) {
      injected.push(input[callIndex]);
    }
    index = callEnd;
  }
  return injected;
}

export function transformRequestBody(body, reasoningByCallId, clientIdentity = "anonymous") {
  const flatToolMap = new Map();
  if (!Array.isArray(body?.tools)) {
    return { body, flatToolMap };
  }

  const occupiedNames = new Set(
    body.tools
      .filter((tool) => tool?.type === "function" && typeof tool.name === "string")
      .map((tool) => tool.name),
  );
  const tools = [];
  for (const tool of body.tools) {
    if (tool?.type === "custom" && typeof tool.name === "string") {
      const wireName = createWireToolName("custom", tool.namespace, tool.name, occupiedNames);
      flatToolMap.set(wireName, {
        kind: "custom",
        namespace: typeof tool.namespace === "string" ? tool.namespace : undefined,
        name: tool.name,
      });
      const originalDescription =
        typeof tool.description === "string" ? tool.description.trim() : "";
      tools.push({
        type: "function",
        name: wireName,
        description: [
          `Call Codex custom tool ${tool.namespace ? `${tool.namespace}.` : ""}${tool.name}.`,
          'Pass the complete custom-tool input in the required string field "input".',
          originalDescription,
        ]
          .filter(Boolean)
          .join("\n\n"),
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Complete unmodified input for the Codex custom tool.",
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
      });
      continue;
    }
    if (tool?.type !== "namespace" || typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
      tools.push(tool);
      continue;
    }
    const namespace = tool.name;
    const namespaceDescription =
      typeof tool.description === "string" ? tool.description.trim() : "";
    for (const child of tool.tools) {
      if (child?.type !== "function" || typeof child.name !== "string") {
        continue;
      }
      const flatName = createWireToolName("namespace", namespace, child.name, occupiedNames);
      flatToolMap.set(flatName, { kind: "namespace", namespace, name: child.name });
      tools.push({
        ...normalizeFunctionTool(child, namespaceDescription),
        name: flatName,
      });
    }
  }

  const transformedInput = Array.isArray(body.input)
    ? body.input.map((item) => transformInputItem(item, flatToolMap))
    : body.input;
  const input = Array.isArray(transformedInput)
    ? keepFunctionCallOutputsAdjacent(
        coalesceFunctionCallOutputs(
          injectRememberedReasoning(
            transformedInput,
            reasoningByCallId,
            clientIdentity,
            body.prompt_cache_key,
            body.model,
          ),
        ),
      )
    : transformedInput;
  const nextBody = { ...body, tools, input };
  if (Object.hasOwn(body, "tool_choice")) {
    nextBody.tool_choice = transformToolChoice(body.tool_choice, flatToolMap);
  }
  return { body: nextBody, flatToolMap };
}

export function restoreFunctionCallItem(item, flatToolMap, maxCustomToolArgumentBytes) {
  if (!item || item.type !== "function_call" || typeof item.name !== "string") {
    return item;
  }
  const original = flatToolMap.get(item.name);
  if (!original) {
    return item;
  }
  if (original.kind === "custom") {
    if (maxCustomToolArgumentBytes !== undefined) {
      assertCompleteCustomToolArgumentBytes(item.arguments, maxCustomToolArgumentBytes);
    }
    let input = item.arguments;
    if (typeof item.arguments === "string") {
      try {
        const parsed = JSON.parse(item.arguments);
        if (parsed && typeof parsed === "object" && typeof parsed.input === "string") {
          input = parsed.input;
        }
      } catch {
        // Preserve the raw provider arguments so Codex can report the malformed call.
      }
    }
    const restored = {
      ...item,
      type: "custom_tool_call",
      name: original.name,
      input: typeof input === "string" ? input : JSON.stringify(input),
    };
    if (original.namespace) {
      restored.namespace = original.namespace;
    } else {
      delete restored.namespace;
    }
    delete restored.arguments;
    return restored;
  }
  return {
    ...item,
    namespace: original.namespace,
    name: original.name,
  };
}

function sseToolCallKeys(event) {
  const ids = [event?.item_id, event?.call_id, event?.item?.id, event?.item?.call_id]
    .filter((value) => typeof value === "string" && value)
    .map((value) => `id:${value}`);
  return Number.isInteger(event?.output_index) ? [...ids, `index:${event.output_index}`] : ids;
}

function rememberCustomToolCall(event, transformedItem, state) {
  if (transformedItem?.type !== "custom_tool_call" || !state) {
    return;
  }
  const accumulator = createCustomToolArgumentAccumulator(state.maxCustomToolArgumentBytes);
  state.customToolCalls ??= new Map();
  for (const key of sseToolCallKeys(event)) {
    state.customToolCalls.set(key, accumulator);
  }
}

function findCustomToolCall(event, state) {
  for (const key of sseToolCallKeys(event)) {
    const accumulator = state.customToolCalls?.get(key);
    if (accumulator) {
      return accumulator;
    }
  }
  return undefined;
}

class CustomToolArgumentsTooLargeError extends Error {}
class BufferedUpstreamResponseTooLargeError extends Error {}

function createCustomToolArgumentAccumulator(maxBytes) {
  return {
    bytes: 0,
    maxBytes,
    input: "",
    parser: {
      state: "seekKey",
      key: "",
      keyEscape: false,
      activeKey: "",
      escapeMode: undefined,
      unicodeDigits: "",
      pendingHighSurrogate: undefined,
    },
  };
}

function assertCustomToolArgumentBytes(accumulator, delta) {
  accumulator.bytes += Buffer.byteLength(delta, "utf8");
  if (accumulator.bytes > accumulator.maxBytes) {
    throw new CustomToolArgumentsTooLargeError("custom tool arguments exceed configured limit");
  }
}

function assertCompleteCustomToolArgumentBytes(argumentsValue, maxBytes) {
  if (typeof argumentsValue === "string" && Buffer.byteLength(argumentsValue, "utf8") > maxBytes) {
    throw new CustomToolArgumentsTooLargeError("custom tool arguments exceed configured limit");
  }
}

function appendDecodedInput(accumulator, delta) {
  accumulator.input += delta;
  return delta;
}

function flushPendingHighSurrogate(parser, accumulator) {
  if (parser.pendingHighSurrogate === undefined) {
    return "";
  }
  const high = parser.pendingHighSurrogate;
  parser.pendingHighSurrogate = undefined;
  return appendDecodedInput(accumulator, String.fromCharCode(high));
}

function decodeUnicodeEscape(parser, accumulator, codeUnit) {
  if (parser.pendingHighSurrogate !== undefined) {
    const high = parser.pendingHighSurrogate;
    parser.pendingHighSurrogate = undefined;
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return appendDecodedInput(
        accumulator,
        String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + (codeUnit - 0xdc00)),
      );
    }
    return appendDecodedInput(
      accumulator,
      `${String.fromCharCode(high)}${String.fromCharCode(codeUnit)}`,
    );
  }
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
    parser.pendingHighSurrogate = codeUnit;
    return "";
  }
  return appendDecodedInput(accumulator, String.fromCharCode(codeUnit));
}

function consumeInputStringChar(accumulator, char) {
  const parser = accumulator.parser;
  if (parser.escapeMode === "unicode") {
    if (!/^[0-9a-fA-F]$/.test(char)) {
      parser.state = "done";
      return "";
    }
    parser.unicodeDigits += char;
    if (parser.unicodeDigits.length < 4) {
      return "";
    }
    const codeUnit = Number.parseInt(parser.unicodeDigits, 16);
    parser.unicodeDigits = "";
    parser.escapeMode = undefined;
    return decodeUnicodeEscape(parser, accumulator, codeUnit);
  }

  if (parser.escapeMode === "afterBackslash") {
    parser.escapeMode = undefined;
    const simpleEscapes = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (char in simpleEscapes) {
      return (
        flushPendingHighSurrogate(parser, accumulator) +
        appendDecodedInput(accumulator, simpleEscapes[char])
      );
    }
    if (char === "u") {
      parser.escapeMode = "unicode";
      parser.unicodeDigits = "";
    } else {
      parser.state = "done";
    }
    return "";
  }

  if (char === '"') {
    const decoded = flushPendingHighSurrogate(parser, accumulator);
    parser.state = "done";
    return decoded;
  }
  if (char === "\\") {
    parser.escapeMode = "afterBackslash";
    return "";
  }
  return flushPendingHighSurrogate(parser, accumulator) + appendDecodedInput(accumulator, char);
}

function skipJsonValueChar(parser, char) {
  if (parser.skipString) {
    if (parser.skipEscape) {
      parser.skipEscape = false;
    } else if (char === "\\") {
      parser.skipEscape = true;
    } else if (char === '"') {
      parser.skipString = false;
    }
    return;
  }
  if (char === '"') {
    parser.skipString = true;
    return;
  }
  if (char === "{" || char === "[") {
    parser.skipDepth += 1;
    return;
  }
  if (char === "}" || char === "]") {
    if (parser.skipDepth > 0) {
      parser.skipDepth -= 1;
      return;
    }
    parser.state = "seekKey";
    return;
  }
  if (parser.skipDepth === 0 && char === ",") {
    parser.state = "seekKey";
  }
}

function consumeCustomToolArgumentDelta(accumulator, delta) {
  assertCustomToolArgumentBytes(accumulator, delta);
  let decoded = "";
  const parser = accumulator.parser;
  for (const char of delta) {
    if (parser.state === "done") {
      continue;
    }
    if (parser.state === "seekKey") {
      if (char === '"') {
        parser.state = "key";
        parser.key = "";
        parser.keyEscape = false;
      }
      continue;
    }
    if (parser.state === "key") {
      if (parser.keyEscape) {
        parser.key += char;
        parser.keyEscape = false;
      } else if (char === "\\") {
        parser.keyEscape = true;
      } else if (char === '"') {
        parser.activeKey = parser.key;
        parser.state = "afterKey";
      } else {
        parser.key += char;
      }
      continue;
    }
    if (parser.state === "afterKey") {
      if (/\s/.test(char)) {
        continue;
      }
      parser.state = char === ":" ? "beforeValue" : "done";
      continue;
    }
    if (parser.state === "beforeValue") {
      if (/\s/.test(char)) {
        continue;
      }
      if (parser.activeKey === "input" && char === '"') {
        parser.state = "inputString";
        continue;
      }
      parser.state = "skipValue";
      parser.skipDepth = 0;
      parser.skipString = false;
      parser.skipEscape = false;
      skipJsonValueChar(parser, char);
      continue;
    }
    if (parser.state === "skipValue") {
      skipJsonValueChar(parser, char);
      continue;
    }
    if (parser.state === "inputString") {
      decoded += consumeInputStringChar(accumulator, char);
    }
  }
  return decoded;
}

function unwrapCustomToolInput(argumentsValue) {
  if (typeof argumentsValue === "string") {
    try {
      const parsed = JSON.parse(argumentsValue);
      if (parsed && typeof parsed === "object" && typeof parsed.input === "string") {
        return parsed.input;
      }
    } catch {
      return argumentsValue;
    }
    return argumentsValue;
  }
  return JSON.stringify(argumentsValue);
}

function restoreFunctionCallArgumentsDoneEvent(value, flatToolMap) {
  if (value?.type !== "response.function_call_arguments.done" || typeof value.name !== "string") {
    return value;
  }
  const original = flatToolMap.get(value.name);
  if (original?.kind !== "namespace") {
    return value;
  }
  return {
    ...value,
    namespace: original.namespace,
    name: original.name,
  };
}

function transformResponseJson(value, flatToolMap, state) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformResponseJson(item, flatToolMap, state));
  }

  observeResponseValue(value, state);
  let next = restoreFunctionCallArgumentsDoneEvent(value, flatToolMap);
  if (value.item) {
    const transformed = restoreFunctionCallItem(
      value.item,
      flatToolMap,
      state?.maxCustomToolArgumentBytes,
    );
    if (transformed !== value.item) {
      next = { ...next, item: transformed };
      rememberCustomToolCall(value, transformed, state);
    }
  }
  if (value.response?.output && Array.isArray(value.response.output)) {
    next = {
      ...next,
      response: {
        ...value.response,
        output: value.response.output.map((item) =>
          restoreFunctionCallItem(item, flatToolMap, state?.maxCustomToolArgumentBytes),
        ),
      },
    };
  }
  if (Array.isArray(value.output)) {
    next = {
      ...next,
      output: value.output.map((item) =>
        restoreFunctionCallItem(item, flatToolMap, state?.maxCustomToolArgumentBytes),
      ),
    };
  }
  if (value.type === "response.function_call_arguments.delta" && state) {
    const accumulator = findCustomToolCall(value, state);
    if (accumulator && typeof value.delta === "string") {
      const delta = consumeCustomToolArgumentDelta(accumulator, value.delta);
      if (delta) {
        return { ...next, type: "response.custom_tool_call_input.delta", delta };
      }
      return undefined;
    }
  }
  if (value.type === "response.function_call_arguments.done" && state) {
    const accumulator = findCustomToolCall(value, state);
    if (accumulator) {
      const { arguments: argumentsValue, name: _name, ...rest } = next;
      assertCompleteCustomToolArgumentBytes(argumentsValue, accumulator.maxBytes);
      const input = unwrapCustomToolInput(argumentsValue);
      return {
        ...rest,
        type: "response.custom_tool_call_input.done",
        input,
      };
    }
  }
  return next;
}

export function splitSseChunkLines(chunk, state) {
  const bufferedBytes = state.bufferBytes ?? Buffer.byteLength(state.buffer, "utf8");
  const combinedBufferBytes = bufferedBytes + Buffer.byteLength(chunk, "utf8");
  assertBufferedUpstreamResponseBytes(combinedBufferBytes);

  const lastNewlineIndex = chunk.lastIndexOf("\n");
  if (lastNewlineIndex === -1) {
    state.buffer += chunk;
    state.bufferBytes = combinedBufferBytes;
    return [];
  }

  const trailingBufferBytes = Buffer.byteLength(chunk.slice(lastNewlineIndex + 1), "utf8");
  assertBufferedUpstreamResponseBytes(trailingBufferBytes);
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? "";
  state.bufferBytes = trailingBufferBytes;
  for (const line of lines) {
    assertBufferedUpstreamResponseBytes(Buffer.byteLength(line, "utf8"));
  }
  return lines;
}

function transformSseChunk(chunk, state, flatToolMap) {
  const lines = splitSseChunkLines(chunk, state);
  return (
    lines
      .map((line) => {
        if (!line.startsWith("data:")) {
          return line;
        }
        const data = line.slice(5).trimStart();
        if (!data || data === "[DONE]") {
          return line;
        }
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          return line;
        }
        const transformed = transformResponseJson(parsed, flatToolMap, state);
        return transformed === undefined ? undefined : `data: ${JSON.stringify(transformed)}`;
      })
      .filter((line) => line !== undefined)
      .join("\n") + "\n"
  );
}

function inspectSseChunk(chunk, state) {
  const lines = splitSseChunkLines(chunk, state);
  let hasOutput = false;
  let terminal = false;
  let retryableInternalError = false;

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const event = JSON.parse(data);
      if (
        event?.type === "response.output_item.added" ||
        event?.type === "response.output_text.delta" ||
        event?.type === "response.function_call_arguments.delta" ||
        event?.type === "response.reasoning_summary_text.delta" ||
        event?.type === "response.reasoning_text.delta"
      ) {
        hasOutput = true;
      }
      if (event?.type === "response.completed" || event?.type === "response.failed") {
        terminal = true;
      }
      if (event?.type === "response.failed" && event?.response?.error?.code === "internal_error") {
        retryableInternalError = true;
      }
    } catch {
      // Preserve unknown provider events; Codex remains the protocol authority.
    }
  }

  return { hasOutput, terminal, retryableInternalError };
}

function writeUpstreamHeaders(res, upstreamResponse) {
  const contentType = upstreamResponse.headers.get("content-type") || "application/json";
  res.writeHead(upstreamResponse.status, {
    "content-type": contentType,
    "cache-control": "no-cache",
  });
}

function sleep(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function writeResponseChunk(res, chunk) {
  if (!chunk || res.write(chunk)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("client disconnected while receiving response"));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

function assertBufferedUpstreamResponseBytes(byteCount) {
  if (byteCount > MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES) {
    throw new BufferedUpstreamResponseTooLargeError("upstream response exceeds buffered limit");
  }
}

async function cancelUpstreamReader(reader, reason) {
  try {
    await reader.cancel(reason);
  } catch {
    // Preserve the original relay/read failure when cancellation also fails.
  }
}

async function readUpstreamText(upstreamResponse) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    return "";
  }
  try {
    const contentLength = Number(upstreamResponse.headers.get("content-length"));
    if (Number.isFinite(contentLength)) {
      assertBufferedUpstreamResponseBytes(contentLength);
    }
    const chunks = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      assertBufferedUpstreamResponseBytes(receivedBytes);
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    await cancelUpstreamReader(reader, error);
    throw error;
  }
}

async function relaySseAttempt({
  upstreamResponse,
  res,
  flatToolMap,
  canRetry,
  maxCustomToolArgumentBytes,
  reasoningByCallId,
  model,
  promptCacheKey,
  clientIdentity,
}) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    writeUpstreamHeaders(res, upstreamResponse);
    res.end();
    return "done";
  }

  const decoder = new TextDecoder();
  const transformState = {
    buffer: "",
    maxCustomToolArgumentBytes,
    reasoningByCallId,
    model,
    promptCacheKey,
    clientIdentity,
  };
  const inspectionState = { buffer: "" };
  let heldOutput = "";
  let heldOutputBytes = 0;
  let committed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      const inspection = inspectSseChunk(chunk, inspectionState);
      const transformed = transformSseChunk(chunk, transformState, flatToolMap);

      if (committed) {
        await writeResponseChunk(res, transformed);
        continue;
      }

      heldOutput += transformed;
      heldOutputBytes += Buffer.byteLength(transformed, "utf8");
      assertBufferedUpstreamResponseBytes(heldOutputBytes);
      if (inspection.retryableInternalError && canRetry) {
        await cancelUpstreamReader(reader);
        return "retry";
      }
      if (inspection.hasOutput || inspection.terminal) {
        writeUpstreamHeaders(res, upstreamResponse);
        await writeResponseChunk(res, heldOutput);
        heldOutput = "";
        heldOutputBytes = 0;
        committed = true;
      }
    }

    const finalChunk = decoder.decode();
    if (finalChunk) {
      const inspection = inspectSseChunk(finalChunk, inspectionState);
      const transformed = transformSseChunk(finalChunk, transformState, flatToolMap);
      heldOutput += transformed;
      heldOutputBytes += Buffer.byteLength(transformed, "utf8");
      assertBufferedUpstreamResponseBytes(heldOutputBytes);
      if (!committed && inspection.retryableInternalError && canRetry) {
        return "retry";
      }
    }
    if (transformState.buffer) {
      const transformed = transformSseChunk("\n", transformState, flatToolMap);
      heldOutput += transformed;
      heldOutputBytes += Buffer.byteLength(transformed, "utf8");
      assertBufferedUpstreamResponseBytes(heldOutputBytes);
    }
    if (!committed) {
      writeUpstreamHeaders(res, upstreamResponse);
    }
    res.end(heldOutput);
    return "done";
  } catch (error) {
    await cancelUpstreamReader(reader, error);
    throw error;
  }
}

class RequestTooLargeError extends Error {}

function readIntegerOption(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function readRequestJson(req, maxRequestBytes) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      req.pause();
      reject(new RequestTooLargeError("request body exceeds configured limit"));
      return;
    }
    const chunks = [];
    let receivedBytes = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > maxRequestBytes) {
        req.pause();
        reject(new RequestTooLargeError("request body exceeds configured limit"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("aborted", () => reject(new Error("client aborted request body")));
    req.on("error", reject);
  });
}

export function createAdapterServer(options = {}) {
  const upstreamUrl =
    options.upstreamUrl ??
    process.env.OPENCLAW_CODEX_RESPONSES_UPSTREAM_URL ??
    "https://qianfan.baidubce.com/v2/responses";
  const upstreamApiKey = normalizeOptionalBearerToken(
    options.upstreamApiKey ?? process.env.OPENCLAW_CODEX_RESPONSES_UPSTREAM_API_KEY,
  );
  const clientApiKey = normalizeOptionalBearerToken(
    options.clientApiKey ?? process.env.OPENCLAW_CODEX_RESPONSES_CLIENT_API_KEY,
  );
  // A configured upstream credential must never turn this process into an
  // unauthenticated credential proxy. An explicit client key can separate the
  // two trust domains; otherwise callers must present the upstream key itself.
  const requiredClientApiKey = clientApiKey ?? upstreamApiKey;
  const maxInternalErrorAttempts = readIntegerOption(
    options.maxInternalErrorAttempts ??
      process.env.OPENCLAW_BAIDU_CODEX_INTERNAL_ERROR_ATTEMPTS ??
      "3",
    "OPENCLAW_BAIDU_CODEX_INTERNAL_ERROR_ATTEMPTS",
    1,
    MAX_INTERNAL_ERROR_ATTEMPTS,
  );
  const internalErrorRetryDelayMs = readIntegerOption(
    options.internalErrorRetryDelayMs ??
      process.env.OPENCLAW_BAIDU_CODEX_INTERNAL_ERROR_RETRY_DELAY_MS ??
      "250",
    "OPENCLAW_BAIDU_CODEX_INTERNAL_ERROR_RETRY_DELAY_MS",
    0,
    MAX_TIMER_MS,
  );
  const maximumRetryMultiplier = Math.max(1, maxInternalErrorAttempts - 1);
  if (internalErrorRetryDelayMs > Math.floor(MAX_TIMER_MS / maximumRetryMultiplier)) {
    throw new Error(
      "OPENCLAW_BAIDU_CODEX_INTERNAL_ERROR_RETRY_DELAY_MS is too large for the configured retry attempts",
    );
  }
  const maxRequestBytes = readIntegerOption(
    options.maxRequestBytes ??
      process.env.OPENCLAW_BAIDU_CODEX_ADAPTER_MAX_REQUEST_BYTES ??
      DEFAULT_MAX_REQUEST_BYTES,
    "OPENCLAW_BAIDU_CODEX_ADAPTER_MAX_REQUEST_BYTES",
    1,
    MAX_REQUEST_BYTES,
  );
  const maxCustomToolArgumentBytes = readIntegerOption(
    options.maxCustomToolArgumentBytes ?? DEFAULT_MAX_CUSTOM_TOOL_ARGUMENT_BYTES,
    "maxCustomToolArgumentBytes",
    1,
    MAX_CUSTOM_TOOL_ARGUMENT_BYTES,
  );
  const upstreamTimeoutMs = readIntegerOption(
    options.upstreamTimeoutMs ?? process.env.OPENCLAW_BAIDU_CODEX_UPSTREAM_TIMEOUT_MS ?? "600000",
    "OPENCLAW_BAIDU_CODEX_UPSTREAM_TIMEOUT_MS",
    1,
    MAX_TIMER_MS,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const reasoningByCallId = new Map();

  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (
      requiredClientApiKey &&
      !matchesBearerToken(req.headers.authorization, requiredClientApiKey)
    ) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    try {
      const incomingBody = await readRequestJson(req, maxRequestBytes);
      const clientIdentity = clientIdentityFromAuthorization(req.headers.authorization);
      const { body, flatToolMap } = transformRequestBody(
        incomingBody,
        reasoningByCallId,
        clientIdentity,
      );
      const clientAbort = new AbortController();
      const timeoutSignal = AbortSignal.timeout(upstreamTimeoutMs);
      const upstreamSignal = AbortSignal.any([clientAbort.signal, timeoutSignal]);
      req.once("aborted", () => clientAbort.abort(new Error("client aborted request")));
      res.once("close", () => {
        if (!res.writableEnded) {
          clientAbort.abort(new Error("client disconnected"));
        }
      });
      for (let attempt = 1; attempt <= maxInternalErrorAttempts; attempt += 1) {
        const upstreamResponse = await fetchImpl(upstreamUrl, {
          method: "POST",
          headers: {
            ...(upstreamApiKey
              ? { authorization: `Bearer ${upstreamApiKey}` }
              : req.headers.authorization
                ? { authorization: req.headers.authorization }
                : {}),
            "content-type": "application/json",
            accept: req.headers.accept || "text/event-stream",
          },
          body: JSON.stringify(body),
          signal: upstreamSignal,
        });
        const contentType = upstreamResponse.headers.get("content-type") || "application/json";
        const canRetry = attempt < maxInternalErrorAttempts;

        if (contentType.toLowerCase().includes("text/event-stream")) {
          const outcome = await relaySseAttempt({
            upstreamResponse,
            res,
            flatToolMap,
            canRetry,
            maxCustomToolArgumentBytes,
            reasoningByCallId,
            model: body.model,
            promptCacheKey: body.prompt_cache_key,
            clientIdentity,
          });
          if (outcome === "done") {
            return;
          }
        } else {
          const text = await readUpstreamText(upstreamResponse);
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            writeUpstreamHeaders(res, upstreamResponse);
            res.end(text);
            return;
          }
          const retryableInternalError =
            parsed?.error?.code === "internal_error" ||
            parsed?.response?.error?.code === "internal_error";
          if (!retryableInternalError || !canRetry) {
            const transformed = transformResponseJson(parsed, flatToolMap, {
              maxCustomToolArgumentBytes,
              reasoningByCallId,
              model: body.model,
              promptCacheKey: body.prompt_cache_key,
              clientIdentity,
            });
            writeUpstreamHeaders(res, upstreamResponse);
            res.end(JSON.stringify(transformed));
            return;
          }
        }

        upstreamSignal.throwIfAborted();
        console.error(`baidu internal_error; retrying upstream attempt ${attempt + 1}`);
        await sleep(internalErrorRetryDelayMs * attempt, upstreamSignal);
      }
    } catch (error) {
      if (res.destroyed) {
        return;
      }
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const requestTooLarge = error instanceof RequestTooLargeError;
      const customToolArgumentsTooLarge = error instanceof CustomToolArgumentsTooLargeError;
      const bufferedUpstreamResponseTooLarge =
        error instanceof BufferedUpstreamResponseTooLargeError;
      const upstreamTimeout = error?.name === "TimeoutError";
      res.writeHead(
        requestTooLarge || customToolArgumentsTooLarge || bufferedUpstreamResponseTooLarge
          ? 413
          : upstreamTimeout
            ? 504
            : 500,
        {
          "content-type": "application/json",
        },
      );
      res.end(
        JSON.stringify({
          error: requestTooLarge
            ? "request_too_large"
            : customToolArgumentsTooLarge
              ? "custom_tool_arguments_too_large"
              : bufferedUpstreamResponseTooLarge
                ? "upstream_response_too_large"
                : upstreamTimeout
                  ? "upstream_timeout"
                  : error instanceof Error
                    ? error.message
                    : String(error),
        }),
      );
    }
  });
}

function matchesBearerToken(authorization, expectedToken) {
  if (typeof authorization !== "string") {
    return false;
  }
  const match = /^Bearer[\t ]+(.+)$/i.exec(authorization);
  if (!match) {
    return false;
  }
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeOptionalBearerToken(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function clientIdentityFromAuthorization(authorization) {
  const normalized = typeof authorization === "string" ? authorization.trim() : "";
  return createHash("sha256")
    .update(normalized || "anonymous")
    .digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.OPENCLAW_BAIDU_CODEX_ADAPTER_PORT || "8046");
  const host = process.env.OPENCLAW_BAIDU_CODEX_ADAPTER_HOST || "127.0.0.1";
  const server = createAdapterServer();
  server.listen(port, host, () => {
    console.error(`openclaw codex baidu adapter listening on ${host}:${port}`);
  });
}
