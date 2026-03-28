import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { TSchema } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  TASKLIST_UPDATE_FIELD_VALUES,
  TASK_UPDATE_FIELD_VALUES,
  type AddTaskToTasklistParams,
  type AddTasklistMembersParams,
  type CreateSubtaskParams,
  type CreateTaskCommentParams,
  type CreateTaskParams,
  type CreateTasklistParams,
  type DeleteTaskAttachmentParams,
  type DeleteTaskCommentParams,
  type DeleteTaskParams,
  type DeleteTasklistParams,
  type GetTaskAttachmentParams,
  type GetTaskCommentParams,
  type GetTaskParams,
  type GetTasklistParams,
  type ListTaskAttachmentsParams,
  type ListTaskCommentsParams,
  type ListTasklistsParams,
  type RemoveTaskFromTasklistParams,
  type RemoveTasklistMembersParams,
  type TaskUpdateTask,
  type TasklistPatchTasklist,
  type UpdateTaskCommentParams,
  type UpdateTasklistParams,
  type UpdateTaskParams,
  type UploadTaskAttachmentParams,
  AddTaskToTasklistSchema,
  AddTasklistMembersSchema,
  CreateSubtaskSchema,
  CreateTaskCommentSchema,
  CreateTaskSchema,
  CreateTasklistSchema,
  DeleteTaskAttachmentSchema,
  DeleteTaskCommentSchema,
  DeleteTaskSchema,
  DeleteTasklistSchema,
  GetTaskAttachmentSchema,
  GetTaskCommentSchema,
  GetTaskSchema,
  GetTasklistSchema,
  ListTaskAttachmentsSchema,
  ListTaskCommentsSchema,
  ListTasklistsSchema,
  RemoveTaskFromTasklistSchema,
  RemoveTasklistMembersSchema,
  UpdateTaskCommentSchema,
  UpdateTaskSchema,
  UpdateTasklistSchema,
  UploadTaskAttachmentSchema,
} from "./task-schema.js";
import { resolveAnyEnabledFeishuToolsConfig, resolveFeishuToolAccount } from "./tool-account.js";
import type { ResolvedFeishuAccount } from "./types.js";

// ============ Types ============

type TaskClient = Lark.Client;

// ============ Constants ============

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_TASK_MEDIA_MAX_MB = 30;
const DEFAULT_TASK_ATTACHMENT_MAX_BYTES = DEFAULT_TASK_MEDIA_MAX_MB * BYTES_PER_MEGABYTE;
const DEFAULT_TASK_ATTACHMENT_FILENAME = "attachment";
const HEX_RADIX = 16;
const RANDOM_TOKEN_PREFIX_LENGTH = 2;
const SIZE_DISPLAY_FRACTION_DIGITS = 0;

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// Lark SDK task v2 returns code?: number (optional; present only on error)
type TaskApiResponse = { code?: number; msg?: string };

async function runTaskApiCall<T extends TaskApiResponse>(
  context: string,
  fn: () => Promise<T>,
): Promise<T> {
  const res = await fn();
  if (res.code !== undefined && res.code !== 0) {
    throw new Error(`${context} failed (code=${res.code}): ${res.msg ?? "unknown error"}`);
  }
  return res;
}

// Helper to safely access data fields from Lark SDK task responses
function d(data: unknown): Record<string, unknown> | undefined {
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return undefined;
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

const SUPPORTED_PATCH_FIELDS = new Set<string>(TASK_UPDATE_FIELD_VALUES);
const SUPPORTED_TASKLIST_PATCH_FIELDS = new Set<string>(TASKLIST_UPDATE_FIELD_VALUES);

function inferUpdateFields(task: TaskUpdateTask): string[] {
  return Object.keys(task).filter((field) => SUPPORTED_PATCH_FIELDS.has(field));
}

function inferTasklistUpdateFields(tasklist: TasklistPatchTasklist): string[] {
  return Object.keys(tasklist).filter((field) => SUPPORTED_TASKLIST_PATCH_FIELDS.has(field));
}

function ensureSupportedUpdateFields(
  updateFields: string[],
  supported: Set<string>,
  resource: "task" | "tasklist",
) {
  const invalid = updateFields.filter((field) => !supported.has(field));
  if (invalid.length > 0) {
    throw new Error(`unsupported ${resource} update_fields: ${invalid.join(", ")}`);
  }
}

function formatTask(task: Record<string, unknown> | undefined) {
  if (!task) return undefined;
  return {
    guid: task.guid,
    task_id: task.task_id,
    summary: task.summary,
    description: task.description,
    status: task.status,
    url: task.url,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
    due: task.due,
    start: task.start,
    is_milestone: task.is_milestone,
    members: task.members,
    tasklists: task.tasklists,
  };
}

function formatTasklist(tasklist: Record<string, unknown> | undefined) {
  if (!tasklist) return undefined;
  return {
    guid: tasklist.guid,
    name: tasklist.name,
    creator: tasklist.creator,
    owner: tasklist.owner,
    members: tasklist.members,
    url: tasklist.url,
    created_at: tasklist.created_at,
    updated_at: tasklist.updated_at,
    archive_msec: tasklist.archive_msec,
  };
}

function formatAttachment(attachment: Record<string, unknown> | undefined) {
  if (!attachment) return undefined;
  return {
    guid: attachment.guid,
    file_token: attachment.file_token,
    name: attachment.name,
    size: attachment.size,
    uploader: attachment.uploader,
    is_cover: attachment.is_cover,
    uploaded_at: attachment.uploaded_at,
    url: attachment.url,
    resource: attachment.resource,
  };
}

function sanitizeUploadFilename(input: string) {
  const base = path.basename(input.trim());
  return base.length > 0 ? base : DEFAULT_TASK_ATTACHMENT_FILENAME;
}

async function ensureUploadableLocalFile(filePath: string, maxBytes: number) {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    throw new Error(`file_path not found: ${filePath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`file_path is not a regular file: ${filePath}`);
  }

  if (stat.size > maxBytes) {
    throw new Error(
      `file_path exceeds ${(maxBytes / BYTES_PER_MEGABYTE).toFixed(SIZE_DISPLAY_FRACTION_DIGITS)}MB limit: ${filePath}`,
    );
  }
}

async function saveBufferToTempFile(buffer: Buffer, fileName: string) {
  const safeName = sanitizeUploadFilename(fileName);
  const tempPath = path.join(
    os.tmpdir(),
    `feishu-task-attachment-${Date.now()}-${Math.random().toString(HEX_RADIX).slice(RANDOM_TOKEN_PREFIX_LENGTH)}-${safeName}`,
  );

  await fs.promises.writeFile(tempPath, buffer);

  return {
    tempPath,
    cleanup: async () => {
      await fs.promises.unlink(tempPath).catch(() => undefined);
    },
  };
}

async function downloadToTempFile(fileUrl: string, filename: string | undefined, maxBytes: number) {
  const loaded = await getFeishuRuntime().media.loadWebMedia(fileUrl, {
    maxBytes,
    optimizeImages: false,
  });

  const parsedPath = (() => {
    try {
      return new URL(fileUrl).pathname;
    } catch {
      return "";
    }
  })();

  const fallbackName = path.basename(parsedPath) || DEFAULT_TASK_ATTACHMENT_FILENAME;
  const preferredName = filename?.trim() ? filename : (loaded.fileName ?? fallbackName);
  return saveBufferToTempFile(loaded.buffer, preferredName);
}

// ============ Actions ============

async function createTask(client: TaskClient, params: CreateTaskParams) {
  const res = await runTaskApiCall("task.v2.task.create", () =>
    client.task.v2.task.create({
      data: omitUndefined({
        summary: params.summary,
        description: params.description,
        due: params.due,
        start: params.start,
        extra: params.extra,
        completed_at: params.completed_at,
        members: params.members,
        repeat_rule: params.repeat_rule,
        tasklists: params.tasklists,
        mode: params.mode,
        is_milestone: params.is_milestone,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
  };
}

async function createSubtask(client: TaskClient, params: CreateSubtaskParams) {
  const res = await runTaskApiCall("task.v2.taskSubtask.create", () =>
    client.task.v2.taskSubtask.create({
      path: { task_guid: params.task_guid },
      data: omitUndefined({
        summary: params.summary,
        description: params.description,
        due: params.due,
        start: params.start,
        extra: params.extra,
        completed_at: params.completed_at,
        members: params.members,
        repeat_rule: params.repeat_rule,
        tasklists: params.tasklists,
        mode: params.mode,
        is_milestone: params.is_milestone,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    subtask: formatTask((res.data?.subtask ?? undefined) as Record<string, unknown> | undefined),
  };
}

async function getTask(client: TaskClient, params: GetTaskParams) {
  const res = await runTaskApiCall("task.v2.task.get", () =>
    client.task.v2.task.get({
      path: { task_guid: params.task_guid },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
  };
}

async function updateTask(client: TaskClient, params: UpdateTaskParams) {
  const task = omitUndefined(params.task as Record<string, unknown>) as TaskUpdateTask;
  const updateFields = params.update_fields?.length
    ? params.update_fields
    : inferUpdateFields(task);

  if (params.update_fields?.length) {
    ensureSupportedUpdateFields(updateFields, SUPPORTED_PATCH_FIELDS, "task");
  }

  if (Object.keys(task).length === 0) {
    throw new Error("task update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from task payload");
  }

  const res = await runTaskApiCall("task.v2.task.patch", () =>
    client.task.v2.task.patch({
      path: { task_guid: params.task_guid },
      data: {
        task,
        update_fields: updateFields,
      },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
    update_fields: updateFields,
  };
}

async function deleteTask(client: TaskClient, taskGuid: string) {
  await runTaskApiCall("task.v2.task.delete", () =>
    client.task.v2.task.delete({
      path: { task_guid: taskGuid },
    }),
  );

  return { success: true, task_guid: taskGuid };
}

async function addTaskToTasklist(client: TaskClient, params: AddTaskToTasklistParams) {
  const res = await runTaskApiCall("task.v2.task.add_tasklist", () =>
    client.task.v2.task.addTasklist({
      path: { task_guid: params.task_guid },
      data: omitUndefined({
        tasklist_guid: params.tasklist_guid,
        section_guid: params.section_guid,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
  };
}

async function removeTaskFromTasklist(client: TaskClient, params: RemoveTaskFromTasklistParams) {
  const res = await runTaskApiCall("task.v2.task.remove_tasklist", () =>
    client.task.v2.task.removeTasklist({
      path: { task_guid: params.task_guid },
      data: omitUndefined({
        tasklist_guid: params.tasklist_guid,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    task: formatTask((res.data?.task ?? undefined) as Record<string, unknown> | undefined),
  };
}

async function createTasklist(client: TaskClient, params: CreateTasklistParams) {
  const res = await runTaskApiCall("task.v2.tasklist.create", () =>
    client.task.v2.tasklist.create({
      data: omitUndefined({
        name: params.name,
        members: params.members,
        archive_tasklist: params.archive_tasklist,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function getTasklist(client: TaskClient, params: GetTasklistParams) {
  const res = await runTaskApiCall("task.v2.tasklist.get", () =>
    client.task.v2.tasklist.get({
      path: { tasklist_guid: params.tasklist_guid },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function listTasklists(client: TaskClient, params: ListTasklistsParams) {
  const res = await runTaskApiCall("task.v2.tasklist.list", () =>
    client.task.v2.tasklist.list({
      params: omitUndefined({
        page_size: params.page_size,
        page_token: params.page_token,
        user_id_type: params.user_id_type,
      }),
    }),
  );

  const items = (res.data?.items ?? []) as Record<string, unknown>[];

  return {
    items: items.map((item) => formatTasklist(item)),
    page_token: res.data?.page_token,
    has_more: res.data?.has_more,
  };
}

async function updateTasklist(client: TaskClient, params: UpdateTasklistParams) {
  const tasklist = omitUndefined(
    params.tasklist as Record<string, unknown>,
  ) as TasklistPatchTasklist;
  const updateFields = params.update_fields?.length
    ? params.update_fields
    : inferTasklistUpdateFields(tasklist);

  if (params.update_fields?.length) {
    ensureSupportedUpdateFields(updateFields, SUPPORTED_TASKLIST_PATCH_FIELDS, "tasklist");
  }

  if (Object.keys(tasklist).length === 0) {
    throw new Error("tasklist update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from tasklist payload");
  }

  const res = await runTaskApiCall("task.v2.tasklist.patch", () =>
    client.task.v2.tasklist.patch({
      path: { tasklist_guid: params.tasklist_guid },
      data: omitUndefined({
        tasklist,
        update_fields: updateFields,
        origin_owner_to_role: params.origin_owner_to_role,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
    update_fields: updateFields,
  };
}

async function deleteTasklist(client: TaskClient, tasklistGuid: string) {
  await runTaskApiCall("task.v2.tasklist.delete", () =>
    client.task.v2.tasklist.delete({
      path: { tasklist_guid: tasklistGuid },
    }),
  );

  return { success: true, tasklist_guid: tasklistGuid };
}

async function addTasklistMembers(client: TaskClient, params: AddTasklistMembersParams) {
  const res = await runTaskApiCall("task.v2.tasklist.addMembers", () =>
    client.task.v2.tasklist.addMembers({
      path: { tasklist_guid: params.tasklist_guid },
      data: { members: params.members },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function removeTasklistMembers(client: TaskClient, params: RemoveTasklistMembersParams) {
  const res = await runTaskApiCall("task.v2.tasklist.removeMembers", () =>
    client.task.v2.tasklist.removeMembers({
      path: { tasklist_guid: params.tasklist_guid },
      data: { members: params.members },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    tasklist: formatTasklist(
      (res.data?.tasklist ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function createTaskComment(client: TaskClient, params: CreateTaskCommentParams) {
  const res = await runTaskApiCall("task.v2.comment.create", () =>
    client.task.v2.comment.create({
      data: omitUndefined({
        content: params.content,
        reply_to_comment_id: params.reply_to_comment_id,
        resource_type: "task",
        resource_id: params.task_guid,
      }),
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return { comment: res.data?.comment };
}

async function listTaskComments(client: TaskClient, params: ListTaskCommentsParams) {
  const res = await runTaskApiCall("task.v2.comment.list", () =>
    client.task.v2.comment.list({
      params: omitUndefined({
        resource_type: "task",
        resource_id: params.task_guid,
        page_size: params.page_size,
        page_token: params.page_token,
        direction: params.direction,
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    items: res.data?.items,
    page_token: res.data?.page_token,
    has_more: res.data?.has_more,
  };
}

async function getTaskComment(client: TaskClient, params: GetTaskCommentParams) {
  const res = await runTaskApiCall("task.v2.comment.get", () =>
    client.task.v2.comment.get({
      path: { comment_id: params.comment_id },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return { comment: res.data?.comment };
}

async function updateTaskComment(client: TaskClient, params: UpdateTaskCommentParams) {
  const res = await runTaskApiCall("task.v2.comment.patch", () =>
    client.task.v2.comment.patch({
      path: { comment_id: params.comment_id },
      data: {
        comment: params.comment,
        update_fields: params.update_fields ?? ["content"],
      },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return { comment: res.data?.comment };
}

async function deleteTaskComment(client: TaskClient, commentId: string) {
  await runTaskApiCall("task.v2.comment.delete", () =>
    client.task.v2.comment.delete({
      path: { comment_id: commentId },
    }),
  );

  return { success: true, comment_id: commentId };
}

async function getTaskAttachment(client: TaskClient, params: GetTaskAttachmentParams) {
  const res = await runTaskApiCall("task.v2.attachment.get", () =>
    client.task.v2.attachment.get({
      path: { attachment_guid: params.attachment_guid },
      params: omitUndefined({
        user_id_type: params.user_id_type,
      }),
    }),
  );

  return {
    attachment: formatAttachment(
      (res.data?.attachment ?? undefined) as Record<string, unknown> | undefined,
    ),
  };
}

async function listTaskAttachments(client: TaskClient, params: ListTaskAttachmentsParams) {
  const res = await runTaskApiCall("task.v2.attachment.list", () =>
    client.task.v2.attachment.list({
      params: omitUndefined({
        resource_type: "task",
        resource_id: params.task_guid,
        page_size: params.page_size,
        page_token: params.page_token,
        updated_mesc: params.updated_mesc,
        user_id_type: params.user_id_type,
      }),
    }),
  );

  const items = (res.data?.items ?? []) as Record<string, unknown>[];

  return {
    items: items.map((item) => formatAttachment(item)),
    page_token: res.data?.page_token,
    has_more: res.data?.has_more,
  };
}

async function deleteTaskAttachment(client: TaskClient, params: DeleteTaskAttachmentParams) {
  await runTaskApiCall("task.v2.attachment.delete", () =>
    client.task.v2.attachment.delete({
      path: { attachment_guid: params.attachment_guid },
    }),
  );

  return { success: true, attachment_guid: params.attachment_guid };
}

async function uploadTaskAttachment(
  client: TaskClient,
  params: UploadTaskAttachmentParams,
  options?: { maxBytes?: number },
) {
  const maxBytes =
    typeof options?.maxBytes === "number" && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_TASK_ATTACHMENT_MAX_BYTES;

  let tempCleanup: (() => Promise<void>) | undefined;
  let filePath: string;

  if (params.file_path) {
    filePath = params.file_path;
    await ensureUploadableLocalFile(filePath, maxBytes);
  } else if (params.file_url) {
    const download = await downloadToTempFile(params.file_url, params.filename, maxBytes);
    filePath = download.tempPath;
    tempCleanup = download.cleanup;
  } else {
    throw new Error("Either file_path or file_url is required");
  }

  try {
    const res = await runTaskApiCall("task.v2.attachment.upload", async () => {
      const data = await client.task.v2.attachment.upload({
        data: {
          resource_type: "task",
          resource_id: params.task_guid,
          file: fs.createReadStream(filePath),
        },
        params: omitUndefined({
          user_id_type: params.user_id_type,
        }),
      });
      return { code: 0, data } as { code: number; data: typeof data };
    });

    const items = (res.data?.items ?? []) as Record<string, unknown>[];

    return { items: items.map((item) => formatAttachment(item)) };
  } finally {
    if (tempCleanup) {
      await tempCleanup();
    }
  }
}

// ============ Tool Registration ============

type TaskToolSpec<P> = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  run: (
    args: { client: TaskClient; account: ResolvedFeishuAccount },
    params: P,
  ) => Promise<unknown>;
};

function registerTaskTool<P>(api: OpenClawPluginApi, spec: TaskToolSpec<P>) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        async execute(_toolCallId, params) {
          const p = params as P & { accountId?: string };
          try {
            const account = resolveFeishuToolAccount({ api, executeParams: p, defaultAccountId });
            const client = createFeishuClient(account);
            return json(await spec.run({ client, account }, p));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      };
    },
    { name: spec.name },
  );
}

export function registerFeishuTaskTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_task: No config available, skipping task tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_task: No Feishu accounts configured, skipping task tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.task) {
    api.logger.debug?.("feishu_task: task tools disabled in config");
    return;
  }

  registerTaskTool<CreateTaskParams>(api, {
    name: "feishu_task_create",
    label: "Feishu Task Create",
    description:
      "Create a Feishu task (task v2). CRITICAL: (1) Always include members with role=assignee using the sender's open_id from Conversation info, or the task will be invisible to the user. (2) due.timestamp must be UTC milliseconds — subtract 8h from CST before converting.",
    parameters: CreateTaskSchema,
    run: async ({ client }, params) => createTask(client, params),
  });

  registerTaskTool<CreateSubtaskParams>(api, {
    name: "feishu_task_subtask_create",
    label: "Feishu Task Subtask Create",
    description:
      "Create a Feishu subtask under a parent task (task v2). CRITICAL: (1) Always include members with role=assignee using the sender's open_id from Conversation info. (2) due.timestamp must be UTC milliseconds.",
    parameters: CreateSubtaskSchema,
    run: async ({ client }, params) => createSubtask(client, params),
  });

  registerTaskTool<GetTaskParams>(api, {
    name: "feishu_task_get",
    label: "Feishu Task Get",
    description: "Get Feishu task details by task_guid (task v2)",
    parameters: GetTaskSchema,
    run: async ({ client }, params) => getTask(client, params),
  });

  registerTaskTool<UpdateTaskParams>(api, {
    name: "feishu_task_update",
    label: "Feishu Task Update",
    description: "Update a Feishu task by task_guid (task v2 patch)",
    parameters: UpdateTaskSchema,
    run: async ({ client }, params) => updateTask(client, params),
  });

  registerTaskTool<DeleteTaskParams>(api, {
    name: "feishu_task_delete",
    label: "Feishu Task Delete",
    description: "Delete a Feishu task by task_guid (task v2)",
    parameters: DeleteTaskSchema,
    run: async ({ client }, { task_guid }) => deleteTask(client, task_guid),
  });

  registerTaskTool<AddTaskToTasklistParams>(api, {
    name: "feishu_task_add_tasklist",
    label: "Feishu Task Add Tasklist",
    description: "Add a task into a tasklist (task v2)",
    parameters: AddTaskToTasklistSchema,
    run: async ({ client }, params) => addTaskToTasklist(client, params),
  });

  registerTaskTool<RemoveTaskFromTasklistParams>(api, {
    name: "feishu_task_remove_tasklist",
    label: "Feishu Task Remove Tasklist",
    description: "Remove a task from a tasklist (task v2)",
    parameters: RemoveTaskFromTasklistSchema,
    run: async ({ client }, params) => removeTaskFromTasklist(client, params),
  });

  registerTaskTool<CreateTasklistParams>(api, {
    name: "feishu_tasklist_create",
    label: "Feishu Tasklist Create",
    description: "Create a Feishu tasklist (task v2)",
    parameters: CreateTasklistSchema,
    run: async ({ client }, params) => createTasklist(client, params),
  });

  registerTaskTool<GetTasklistParams>(api, {
    name: "feishu_tasklist_get",
    label: "Feishu Tasklist Get",
    description: "Get a Feishu tasklist by tasklist_guid (task v2)",
    parameters: GetTasklistSchema,
    run: async ({ client }, params) => getTasklist(client, params),
  });

  registerTaskTool<ListTasklistsParams>(api, {
    name: "feishu_tasklist_list",
    label: "Feishu Tasklist List",
    description: "List Feishu tasklists (task v2)",
    parameters: ListTasklistsSchema,
    run: async ({ client }, params) => listTasklists(client, params),
  });

  registerTaskTool<UpdateTasklistParams>(api, {
    name: "feishu_tasklist_update",
    label: "Feishu Tasklist Update",
    description: "Update a Feishu tasklist by tasklist_guid (task v2 patch)",
    parameters: UpdateTasklistSchema,
    run: async ({ client }, params) => updateTasklist(client, params),
  });

  registerTaskTool<DeleteTasklistParams>(api, {
    name: "feishu_tasklist_delete",
    label: "Feishu Tasklist Delete",
    description: "Delete a Feishu tasklist by tasklist_guid (task v2)",
    parameters: DeleteTasklistSchema,
    run: async ({ client }, { tasklist_guid }) => deleteTasklist(client, tasklist_guid),
  });

  registerTaskTool<AddTasklistMembersParams>(api, {
    name: "feishu_tasklist_add_members",
    label: "Feishu Tasklist Add Members",
    description: "Add members to a Feishu tasklist (task v2)",
    parameters: AddTasklistMembersSchema,
    run: async ({ client }, params) => addTasklistMembers(client, params),
  });

  registerTaskTool<RemoveTasklistMembersParams>(api, {
    name: "feishu_tasklist_remove_members",
    label: "Feishu Tasklist Remove Members",
    description: "Remove members from a Feishu tasklist (task v2)",
    parameters: RemoveTasklistMembersSchema,
    run: async ({ client }, params) => removeTasklistMembers(client, params),
  });

  registerTaskTool<CreateTaskCommentParams>(api, {
    name: "feishu_task_comment_create",
    label: "Feishu Task Comment Create",
    description: "Create a comment on a Feishu task (task v2)",
    parameters: CreateTaskCommentSchema,
    run: async ({ client }, params) => createTaskComment(client, params),
  });

  registerTaskTool<ListTaskCommentsParams>(api, {
    name: "feishu_task_comment_list",
    label: "Feishu Task Comment List",
    description: "List comments for a Feishu task (task v2)",
    parameters: ListTaskCommentsSchema,
    run: async ({ client }, params) => listTaskComments(client, params),
  });

  registerTaskTool<GetTaskCommentParams>(api, {
    name: "feishu_task_comment_get",
    label: "Feishu Task Comment Get",
    description: "Get a Feishu task comment by comment_id (task v2)",
    parameters: GetTaskCommentSchema,
    run: async ({ client }, params) => getTaskComment(client, params),
  });

  registerTaskTool<UpdateTaskCommentParams>(api, {
    name: "feishu_task_comment_update",
    label: "Feishu Task Comment Update",
    description: "Update a Feishu task comment by comment_id (task v2)",
    parameters: UpdateTaskCommentSchema,
    run: async ({ client }, params) => updateTaskComment(client, params),
  });

  registerTaskTool<DeleteTaskCommentParams>(api, {
    name: "feishu_task_comment_delete",
    label: "Feishu Task Comment Delete",
    description: "Delete a Feishu task comment by comment_id (task v2)",
    parameters: DeleteTaskCommentSchema,
    run: async ({ client }, { comment_id }) => deleteTaskComment(client, comment_id as string),
  });

  registerTaskTool<UploadTaskAttachmentParams>(api, {
    name: "feishu_task_attachment_upload",
    label: "Feishu Task Attachment Upload",
    description: "Upload an attachment to a Feishu task (task v2)",
    parameters: UploadTaskAttachmentSchema,
    run: async ({ client, account }, params) => {
      const mediaMaxBytes =
        (account.config.mediaMaxMb ?? DEFAULT_TASK_MEDIA_MAX_MB) * BYTES_PER_MEGABYTE;
      return uploadTaskAttachment(client, params, { maxBytes: mediaMaxBytes });
    },
  });

  registerTaskTool<ListTaskAttachmentsParams>(api, {
    name: "feishu_task_attachment_list",
    label: "Feishu Task Attachment List",
    description: "List attachments for a Feishu task (task v2)",
    parameters: ListTaskAttachmentsSchema,
    run: async ({ client }, params) => listTaskAttachments(client, params),
  });

  registerTaskTool<GetTaskAttachmentParams>(api, {
    name: "feishu_task_attachment_get",
    label: "Feishu Task Attachment Get",
    description: "Get a Feishu task attachment by attachment_guid (task v2)",
    parameters: GetTaskAttachmentSchema,
    run: async ({ client }, params) => getTaskAttachment(client, params),
  });

  registerTaskTool<DeleteTaskAttachmentParams>(api, {
    name: "feishu_task_attachment_delete",
    label: "Feishu Task Attachment Delete",
    description: "Delete a Feishu task attachment by attachment_guid (task v2)",
    parameters: DeleteTaskAttachmentSchema,
    run: async ({ client }, params) => deleteTaskAttachment(client, params),
  });

  api.logger.debug?.(
    "feishu_task: Registered task, tasklist, subtask, comment, and attachment tools",
  );
}
