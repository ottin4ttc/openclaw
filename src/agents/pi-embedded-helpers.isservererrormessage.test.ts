import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isServerErrorMessage,
} from "./pi-embedded-helpers.js";

// Exact errorMessage observed in production (Langfuse) when the OpenAI-compatible
// upstream emitted a stream `error` event with code=server_error. pi-ai wraps it as
// "Error Code ${event.code}: ${event.message}" (openai-responses-shared).
const OPENAI_RESPONSES_SERVER_ERROR_MESSAGE =
  "Error Code server_error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 6d365904-f89e-4984-8360-00197fa9e45c in your message.";

const OPENAI_GENERIC_INTERNAL_MESSAGE =
  "An error occurred while processing your request. Please include the request ID req_abc12345 in your message.";

// dmxapi-style relay error body carrying "type":"upstream_error".
const DMXAPI_UPSTREAM_ERROR_PAYLOAD =
  'LLM API error status=500 body={"error":{"message":"当前分组上游负载已饱和","type":"upstream_error"}}';

const ANTHROPIC_STRUCTURED_SERVER_ERROR_PAYLOAD =
  '{"type":"error","error":{"type":"server_error","message":"Upstream provider failed"},"request_id":"req_test"}';

describe("isServerErrorMessage", () => {
  it("matches pi-ai wrapped OpenAI Responses server_error stream errors", () => {
    expect(isServerErrorMessage(OPENAI_RESPONSES_SERVER_ERROR_MESSAGE)).toBe(true);
  });

  it("matches structured server_error / upstream_error payloads", () => {
    expect(isServerErrorMessage(ANTHROPIC_STRUCTURED_SERVER_ERROR_PAYLOAD)).toBe(true);
    expect(isServerErrorMessage('{"error":{"code":"server_error","message":"boom"}}')).toBe(true);
    expect(isServerErrorMessage(DMXAPI_UPSTREAM_ERROR_PAYLOAD)).toBe(true);
    expect(isServerErrorMessage("Error Code upstream_error: relay exploded")).toBe(true);
  });

  it("matches plain provider internal-error texts", () => {
    expect(isServerErrorMessage("Internal server error")).toBe(true);
    expect(isServerErrorMessage(OPENAI_GENERIC_INTERNAL_MESSAGE)).toBe(true);
    expect(isServerErrorMessage("upstream connect error or disconnect/reset before headers")).toBe(
      true,
    );
  });

  it("matches Chinese provider server-error texts", () => {
    expect(isServerErrorMessage("系统繁忙，请稍后重试")).toBe(true);
    expect(isServerErrorMessage("服务器内部错误")).toBe(true);
  });

  it("does not match unrelated or empty messages", () => {
    expect(isServerErrorMessage("")).toBe(false);
    expect(isServerErrorMessage("tool call validation failed: missing input")).toBe(false);
    expect(isServerErrorMessage("invalid api key")).toBe(false);
  });
});

describe("classifyFailoverReason server errors", () => {
  it("classifies the production OpenAI Responses server_error as transient (timeout)", () => {
    expect(classifyFailoverReason(OPENAI_RESPONSES_SERVER_ERROR_MESSAGE)).toBe("timeout");
    expect(isFailoverErrorMessage(OPENAI_RESPONSES_SERVER_ERROR_MESSAGE)).toBe(true);
  });

  it("classifies structured and Chinese server errors as transient (timeout)", () => {
    expect(classifyFailoverReason(ANTHROPIC_STRUCTURED_SERVER_ERROR_PAYLOAD)).toBe("timeout");
    expect(classifyFailoverReason(DMXAPI_UPSTREAM_ERROR_PAYLOAD)).toBe("timeout");
    expect(classifyFailoverReason("系统繁忙，请稍后重试")).toBe("timeout");
    expect(classifyFailoverReason("Internal server error")).toBe("timeout");
  });

  it("keeps more specific classifications ahead of server errors", () => {
    // Rate limit and overload keywords take precedence over server-error markers.
    expect(classifyFailoverReason("429 rate limit reached; upstream server_error")).toBe(
      "rate_limit",
    );
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe("overloaded");
    // Billing/auth signals must not be swallowed by the transient classification.
    expect(classifyFailoverReason('{"type":"server_error","message":"insufficient credits"}')).toBe(
      "billing",
    );
    expect(classifyFailoverReason('{"type":"server_error","message":"invalid api key"}')).toBe(
      "auth",
    );
  });

  it("marks assistant messages carrying server_error stop errors as failover-worthy", () => {
    const assistant = {
      role: "assistant",
      stopReason: "error",
      errorMessage: OPENAI_RESPONSES_SERVER_ERROR_MESSAGE,
    } as never;
    expect(isFailoverAssistantError(assistant)).toBe(true);
  });
});
