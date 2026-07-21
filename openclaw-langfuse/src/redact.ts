const REDACTED_CONTENT = "[REDACTED]";

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
 * Suppress payload content completely.
 * Field names, scalar values, array lengths, and object shape can all reveal
 * private prompt/tool content, so enabled redaction collapses present payloads
 * to a single marker instead of preserving structure.
 */
export function redactObject<T>(obj: T, enabled = true): T {
  if (!enabled) {
    return obj;
  }
  if (obj === undefined || obj === null) {
    return obj;
  }
  if (typeof obj === "string") {
    return redactText(obj, enabled) as T;
  }
  return REDACTED_CONTENT as T;
}
