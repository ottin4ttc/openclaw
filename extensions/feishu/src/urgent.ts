import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveAnyEnabledFeishuToolsConfig, resolveFeishuToolAccount } from "./tool-account.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ============ Schema ============

const URGENT_TYPE_VALUES = ["app", "sms", "phone"] as const;

const FeishuUrgentSchema = Type.Object({
  message_id: Type.String({
    description:
      "Message ID to send urgent notification for (e.g. om_xxx). The message must already be sent.",
  }),
  user_ids: Type.Array(Type.String(), {
    description:
      "List of open_id values to buzz. Recipients must be members of the chat where the message was sent.",
    minItems: 1,
  }),
  urgent_type: Type.Optional(
    Type.Unsafe<(typeof URGENT_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...URGENT_TYPE_VALUES],
      description:
        "Urgency delivery method: app (in-app buzz, default), sms (SMS push), phone (voice call). Note: sms and phone may incur cost on the tenant.",
      default: "app",
    }),
  ),
  accountId: Type.Optional(Type.String({ description: "Feishu account ID (multi-account)" })),
});

type FeishuUrgentParams = Static<typeof FeishuUrgentSchema>;

// ============ Action ============

type UrgentPayload = {
  data: { user_id_list: string[] };
  params: { user_id_type: "open_id" | "user_id" | "union_id" };
  path: { message_id: string };
};

interface UrgentResponse {
  code: number;
  msg?: string;
  data?: { invalid_user_id_list?: string[] };
}

type LarkMessageWithUrgent = Lark.Client["im"]["message"] & {
  urgentApp?: (payload: UrgentPayload) => Promise<UrgentResponse>;
  urgentSms?: (payload: UrgentPayload) => Promise<UrgentResponse>;
  urgentPhone?: (payload: UrgentPayload) => Promise<UrgentResponse>;
};

async function urgentMessage(
  client: Lark.Client,
  messageId: string,
  userIds: string[],
  urgentType: (typeof URGENT_TYPE_VALUES)[number] = "app",
): Promise<{ invalidUserList: string[] }> {
  const larkMessage = client.im.message as LarkMessageWithUrgent;

  const payload: UrgentPayload = {
    path: { message_id: messageId },
    params: { user_id_type: "open_id" },
    data: { user_id_list: userIds },
  };

  const methodMap = {
    app: larkMessage.urgentApp?.bind(larkMessage),
    sms: larkMessage.urgentSms?.bind(larkMessage),
    phone: larkMessage.urgentPhone?.bind(larkMessage),
  } as const;

  const method = methodMap[urgentType];
  if (typeof method !== "function") {
    throw new Error(
      `Feishu urgent: SDK method not available for urgentType="${urgentType}". ` +
        `Check that @larksuiteoapi/node-sdk is up to date.`,
    );
  }

  const response = await method(payload);
  if (response.code !== 0) {
    throw new Error(
      `Feishu urgent message (${urgentType}) failed (code=${response.code}): ${response.msg ?? "unknown error"}`,
    );
  }

  return {
    invalidUserList: response.data?.invalid_user_id_list ?? [],
  };
}

// ============ Tool Registration ============

export function registerFeishuUrgentTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_urgent: No config available, skipping");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_urgent: No Feishu accounts configured, skipping");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.urgent) {
    api.logger.debug?.("feishu_urgent: urgent tool disabled in config");
    return;
  }

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_urgent",
        label: "Feishu Urgent",
        description:
          "Send an urgent (buzz) notification for an existing Feishu message. " +
          "Supported urgent_type values: app (in-app buzz, default), sms (SMS push), phone (voice call). " +
          "Requires the message_id of an already-sent message and the open_id list of recipients to buzz. " +
          "Use this to escalate important messages that require immediate attention.",
        parameters: FeishuUrgentSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuUrgentParams;
          try {
            const account = resolveFeishuToolAccount({ api, executeParams: p, defaultAccountId });
            const client = createFeishuClient(account);
            const result = await urgentMessage(
              client,
              p.message_id,
              p.user_ids,
              p.urgent_type ?? "app",
            );
            return json({
              ok: true,
              message_id: p.message_id,
              urgent_type: p.urgent_type ?? "app",
              invalid_user_list: result.invalidUserList,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      };
    },
    { name: "feishu_urgent" },
  );

  api.logger.debug?.("feishu_urgent: Registered feishu_urgent tool");
}
