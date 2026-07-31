const REDACTED_CONTENT = "[REDACTED]";
const FAILED_PROJECTION_CONTENT = "[unserializable: projection]";
const OMITTED_PROJECTION_FIELDS = new Set([
  "encrypted_content",
  // OpenClaw stores the provider reasoning continuation as an opaque JSON
  // string here. Drop the envelope from Langfuse while preserving it in the
  // source transcript for same-provider replay.
  "thinkingSignature",
]);

function stringifyLangfuseProjection(value: unknown): string | undefined {
  const ancestors: object[] = [];
  return JSON.stringify(value, function (this: unknown, key, nested) {
    if (OMITTED_PROJECTION_FIELDS.has(key)) {
      return undefined;
    }
    if (!nested || typeof nested !== "object") {
      return nested;
    }
    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(nested)) {
      return "[unserializable: circular]";
    }
    ancestors.push(nested);
    return nested;
  });
}

/**
 * Remove provider continuation payloads that Langfuse cannot interpret.
 * Keep the source object intact because the same reasoning item may still be
 * required by the provider transport on the next call.
 */
export function projectLangfusePayload<T>(value: T): T {
  try {
    const serialized = stringifyLangfuseProjection(value);
    if (serialized === undefined) {
      return value && typeof value === "object" ? (FAILED_PROJECTION_CONTENT as T) : value;
    }
    return JSON.parse(serialized) as T;
  } catch {
    return FAILED_PROJECTION_CONTENT as T;
  }
}

/**
 * Suppress text content completely when redaction is enabled.
 * Returns the original text if redaction is disabled.
 */
export function redactText(text: string, enabled = true): string {
  if (!enabled || !text) {
    return text;
  }
  return REDACTED_CONTENT;
}

/**
 * Suppress payload content completely, or apply the safe Langfuse projection
 * when full redaction is disabled.
 * Field names, scalar values, array lengths, and object shape can all reveal
 * private prompt/tool content, so enabled redaction collapses present payloads
 * to a single marker instead of preserving structure.
 */
export function redactObject<T>(obj: T, enabled = true): T {
  if (!enabled) {
    return projectLangfusePayload(obj);
  }
  if (obj === undefined || obj === null) {
    return obj;
  }
  if (typeof obj === "string") {
    return redactText(obj, enabled) as T;
  }
  return REDACTED_CONTENT as T;
}
