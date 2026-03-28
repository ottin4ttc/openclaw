const REDACT_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string | ((match: string) => string);
}> = [
  // API keys: sk-..., pk-..., key-...
  { pattern: /\b(sk|pk|key)-[a-zA-Z0-9]{20,}\b/g, replacement: "[REDACTED]" },
  // Bearer tokens
  { pattern: /Bearer\s+[a-zA-Z0-9._-]+/gi, replacement: "Bearer [REDACTED]" },
  // Generic API key patterns in JSON
  {
    pattern:
      /"(api_key|apiKey|secret_key|secretKey|access_token|accessToken|password|passwd|token)"\s*:\s*"[^"]+"/gi,
    replacement: (match: string) => match.replace(/"[^"]*"$/, '"[REDACTED]"'),
  },
  // OpenClaw secret refs like $SECRET_NAME
  { pattern: /\$[A-Z_]{2,}[A-Z0-9_]*/g, replacement: "[REDACTED_REF]" },
];

/**
 * Redact sensitive patterns from text.
 * Returns the original text if redaction is disabled.
 */
export function redactText(text: string, enabled = true): string {
  if (!enabled || !text) {
    return text;
  }
  let result = text;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    // Reset lastIndex for global regexes between calls
    pattern.lastIndex = 0;
    if (typeof replacement === "function") {
      result = result.replace(pattern, replacement);
    } else {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

/**
 * Redact sensitive patterns from an object (deep).
 * Processes all string values recursively.
 */
export function redactObject<T>(obj: T, enabled = true): T {
  if (!enabled) {
    return obj;
  }
  if (typeof obj === "string") {
    return redactText(obj, enabled) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, enabled)) as T;
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactObject(value, enabled);
    }
    return result as T;
  }
  return obj;
}
