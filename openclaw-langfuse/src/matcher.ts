export type PromptRule = {
  match: string; // "main" | "openmai-*" | "*"
  langfusePrompt: string;
  version?: number;
  label?: string;
  inject?: "prepend" | "append" | "replace";
};

/**
 * Find the first matching rule for the given agentId.
 * Rules are evaluated in array order (first match wins).
 * Supports:
 * - Exact match: "main" matches only "main"
 * - Wildcard prefix: "openmai-*" matches any string starting with "openmai-"
 * - Catch-all: "*" matches anything
 */
export function findMatchingRule(agentId: string, rules: PromptRule[]): PromptRule | undefined {
  for (const rule of rules) {
    if (ruleMatches(agentId, rule.match)) {
      return rule;
    }
  }
  return undefined;
}

function ruleMatches(agentId: string, pattern: string): boolean {
  // Catch-all
  if (pattern === "*") {
    return true;
  }
  // Wildcard prefix: pattern ends with "*"
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return agentId.startsWith(prefix);
  }
  // Exact match
  return agentId === pattern;
}
