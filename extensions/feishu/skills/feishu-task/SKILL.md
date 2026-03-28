---
name: feishu-task
description: |
  Feishu Task, tasklist, subtask, comment, and attachment management. Activate when user mentions tasks, tasklists, subtasks, task comments, task attachments, or task links.
---

# Feishu Task Tools

Tools:

- `feishu_task_create`
- `feishu_task_subtask_create`
- `feishu_task_get`
- `feishu_task_update`
- `feishu_task_delete`
- `feishu_task_comment_create`
- `feishu_task_comment_list`
- `feishu_task_comment_get`
- `feishu_task_comment_update`
- `feishu_task_comment_delete`
- `feishu_task_attachment_upload`
- `feishu_task_attachment_list`
- `feishu_task_attachment_get`
- `feishu_task_attachment_delete`
- `feishu_task_add_tasklist`
- `feishu_task_remove_tasklist`
- `feishu_tasklist_create`
- `feishu_tasklist_get`
- `feishu_tasklist_list`
- `feishu_tasklist_update`
- `feishu_tasklist_delete`
- `feishu_tasklist_add_members`
- `feishu_tasklist_remove_members`

## CRITICAL: Before Every Task Creation

You MUST follow these two steps every time before calling `feishu_task_create` or `feishu_task_subtask_create`. No exceptions.

### Step 1 — Assignee (REQUIRED)

The requesting user's `open_id` is in the system-injected **"Conversation info (untrusted metadata)"** block under the `sender_id` field. **Always use it as the assignee.** Never create a task without an assignee — the user will not be able to see it.

```
Conversation info (untrusted metadata):
{
  "sender_id": "ou_xxxxxxxxxxxxxxxx",   ← this is the user's open_id
  ...
}
```

Always include in `members`:

```json
{ "id": "<sender_id value>", "role": "assignee", "type": "user" }
```

### Step 2 — Due Date/Time (REQUIRED when user mentions a time)

The Feishu API requires **UTC milliseconds** (13-digit string). Follow this exact procedure:

#### 2a. Get today's date from conversation timestamp (CRITICAL)

The `timestamp` in Conversation info is the **ONLY** source of truth for the current date and time. **Do NOT use your internal training knowledge of today's date — it is stale and will produce timestamps months in the past.**

The `timestamp` field is a human-readable string in the format:

```
"Tue 2026-03-04 20:34 CST"
 ^^^           ^^^^ ^^^ ^^^
 weekday       time  timezone-abbreviation
```

Parse this string to extract the current date, time, and timezone. The timezone abbreviation (e.g. `CST`, `UTC`) tells you what timezone the time is in. Use this to determine the user's current local date and time.

#### 2b. Interpret the user's time expression in local time (CST)

- Explicit 24h: "19:45", "07:30" → use as-is
- "晚上X点" / "下午X点" → PM: use X+12 (if X < 12)
- "早上X点" / "上午X点" → AM: use X
- **Bare "X点" or "X点Y分" without qualifier**: infer from current local hour
  - If current local hour ≥ 12 and X ≤ 11 and X is within a few hours of current time → **treat as PM (X+12)**
  - Example: current local time is 20:00 (evening), user says "7点45" → they mean **19:45 today**, not 07:45 tomorrow
  - If X+12 has already passed today, schedule for the next day at X+12
  - If truly ambiguous, confirm with the user before creating

#### 2c. Convert resolved local datetime to UTC ms

Subtract 8 hours (CST → UTC), then compute Unix milliseconds.

**Worked example**: Conversation info contains `"timestamp": "Tue 2026-03-04 20:00 CST"` → current local time is 2026-03-04 20:00 CST

- User says "7点45" → evening context (current hour = 20) → interpret as **19:45 CST today** (March 4)
- 2026-03-04 19:45 CST = 2026-03-04 11:45 UTC = `1772624700000`
- Pass `"timestamp": "1772624700000"` to the API

**Sanity check (MANDATORY)**: `2026-01-01 00:00 UTC = 1767225600000`. Any timestamp for a 2026 due date **must be greater than 1767225600000**. If your computed value is less than this, you made a year-off error — recompute from scratch using only the conversation timestamp.

**Never** pass local time directly as UTC. Doing so causes an 8-hour offset error.

---

## Notes

- `task_guid` can be taken from a task URL (guid query param) or from `feishu_task_get` output.
- `comment_id` can be obtained from `feishu_task_comment_list` output.
- `attachment_guid` can be obtained from `feishu_task_attachment_list` output.
- `user_id_type` controls returned/accepted user identity type (`open_id`, `user_id`, `union_id`).
- Task visibility: users can only view tasks when they are included as assignee.
- Current limitation: the bot can only create subtasks for tasks created by itself.
- Attachment upload supports local `file_path` and remote `file_url`. Remote URLs are fetched with runtime media safety checks and size limit (`mediaMaxMb`).
- Keep tasklist owner as the bot. Add users as members to avoid losing bot access.
- Use tasklist tools for tasklist membership changes; do not use `feishu_task_update` to move tasks between tasklists.

## Create Task

```json
{
  "summary": "Quarterly review",
  "description": "Prepare review notes",
  "due": { "timestamp": "1772629200000", "is_all_day": false },
  "members": [{ "id": "ou_xxxxxxxxxxxxxxxx", "role": "assignee", "type": "user" }],
  "user_id_type": "open_id"
}
```

## Create Subtask

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "summary": "Draft report outline",
  "description": "Collect key metrics",
  "due": { "timestamp": "1772629200000", "is_all_day": false },
  "members": [{ "id": "ou_xxxxxxxxxxxxxxxx", "role": "assignee", "type": "user" }],
  "user_id_type": "open_id"
}
```

## Create Comment

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "content": "Looks good to me",
  "user_id_type": "open_id"
}
```

## Upload Attachment (file_path)

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "file_path": "/path/to/report.pdf",
  "user_id_type": "open_id"
}
```

## Upload Attachment (file_url)

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "file_url": "https://oss-example.com/bucket/report.pdf",
  "filename": "report.pdf",
  "user_id_type": "open_id"
}
```

## Tasklist Membership For Tasks

### Add Task to Tasklist

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "section_guid": "6d0f9f48-2e06-4e3d-8a0f-acde196e8c61",
  "user_id_type": "open_id"
}
```

### Remove Task from Tasklist

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "user_id_type": "open_id"
}
```

## Tasklists

Tasklists support three roles: owner (read/edit/manage), editor (read/edit), viewer (read).

### Create Tasklist

```json
{
  "name": "Project Alpha Tasklist",
  "members": [{ "id": "ou_xxxxxxxxxxxxxxxx", "type": "user", "role": "editor" }],
  "user_id_type": "open_id"
}
```

### Get Tasklist

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "user_id_type": "open_id"
}
```

### List Tasklists

```json
{
  "page_size": 50,
  "page_token": "aWQ9NzEwMjMzMjMxMDE=",
  "user_id_type": "open_id"
}
```

### Update Tasklist

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "tasklist": {
    "name": "Renamed Tasklist",
    "owner": { "id": "ou_xxxxxxxxxxxxxxxx", "type": "user", "role": "owner" }
  },
  "update_fields": ["name", "owner"],
  "origin_owner_to_role": "editor",
  "user_id_type": "open_id"
}
```

### Delete Tasklist

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004"
}
```

### Add Tasklist Members

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "members": [{ "id": "ou_xxxxxxxxxxxxxxxx", "type": "user", "role": "editor" }],
  "user_id_type": "open_id"
}
```

### Remove Tasklist Members

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "members": [{ "id": "ou_xxxxxxxxxxxxxxxx", "type": "user", "role": "viewer" }],
  "user_id_type": "open_id"
}
```
