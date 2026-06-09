import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/types.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";

/**
 * Cron jobs inject "Current time: ..." into their messages.
 * Skip injection for those.
 */
const CRON_TIME_PATTERN = /Current time: /;

/**
 * Matches a leading `[... YYYY-MM-DD HH:MM ...]` envelope — either from
 * channel plugins or from a previous injection. Uses the same YYYY-MM-DD
 * HH:MM format as {@link formatZonedTimestamp}, so detection stays in sync
 * with the formatting.
 */
const TIMESTAMP_ENVELOPE_PATTERN = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface TimestampInjectionOptions {
  timezone?: string;
  now?: Date;
}

/**
 * Injects an authoritative current-time line into a message if one isn't
 * already present. Uses the same `YYYY-MM-DD HH:MM TZ` format as channel
 * envelope timestamps ({@link formatZonedTimestamp}), while keeping the
 * date/time separate from the user's prose so models treat it as context.
 *
 * Used by the gateway `agent` and `chat.send` handlers to give TUI, web,
 * spawned subagents, `sessions_send`, and heartbeat wake events date/time
 * awareness — without modifying the system prompt (which is cached).
 *
 * Channel messages (Discord, Telegram, etc.) already have timestamps via
 * envelope formatting and take a separate code path — they never reach
 * these handlers, so there is no double-stamping risk. The detection
 * pattern is a safety net for edge cases.
 *
 * @see https://github.com/moltbot/moltbot/issues/3658
 */
export function injectTimestamp(message: string, opts?: TimestampInjectionOptions): string {
  if (!message.trim()) {
    return message;
  }

  // Already has an envelope or injected timestamp
  if (TIMESTAMP_ENVELOPE_PATTERN.test(message)) {
    return message;
  }

  // Already has a cron-injected timestamp
  if (CRON_TIME_PATTERN.test(message)) {
    return message;
  }

  const now = opts?.now ?? new Date();
  const timezone = opts?.timezone ?? "UTC";

  const formatted = formatZonedTimestamp(now, { timeZone: timezone });
  if (!formatted) {
    return message;
  }
  const yesterday = formatZonedTimestamp(new Date(now.getTime() - ONE_DAY_MS), {
    timeZone: timezone,
  });

  // 3-letter DOW: small models (8B) can't reliably derive day-of-week from
  // a date, and may treat a bare "Wed" as a typo. Costs ~1 token.
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(
    now,
  );

  const todayDate = formatted.slice(0, 10);
  const yesterdayDate = yesterday?.slice(0, 10) ?? "";
  const dateHint =
    yesterdayDate.length > 0
      ? `Date hints: today=${todayDate}; yesterday=${yesterdayDate}; use these for memory/YYYY-MM-DD.md paths.`
      : `Date hints: today=${todayDate}; use this for memory/YYYY-MM-DD.md paths.`;

  return `Current time: ${dow} ${formatted}\n${dateHint}\n${message}`;
}

/**
 * Build TimestampInjectionOptions from an OpenClawConfig.
 */
export function timestampOptsFromConfig(cfg: OpenClawConfig): TimestampInjectionOptions {
  return {
    timezone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
  };
}
