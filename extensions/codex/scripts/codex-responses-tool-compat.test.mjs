import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const adapterUrl = new URL("./codex-responses-tool-compat.mjs", import.meta.url);

test("ships the Codex Responses compatibility adapter with the plugin", () => {
  assert.equal(existsSync(fileURLToPath(adapterUrl)), true);
});

test("flattens custom and namespace tools and restores provider calls", async () => {
  assert.equal(existsSync(fileURLToPath(adapterUrl)), true);
  const { restoreFunctionCallItem, transformRequestBody } = await import(adapterUrl.href);
  const request = transformRequestBody({
    tools: [
      { type: "custom", name: "exec", description: "Run a command" },
      {
        type: "namespace",
        name: "workspace",
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    request.body.tools.map((tool) => tool.type),
    ["function", "function"],
  );
  const customWireName = request.body.tools[0].name;
  const namespaceWireName = request.body.tools[1].name;
  assert.deepEqual(
    restoreFunctionCallItem(
      {
        type: "function_call",
        name: customWireName,
        call_id: "call-custom",
        arguments: JSON.stringify({ input: "pwd" }),
      },
      request.flatToolMap,
    ),
    {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call-custom",
      input: "pwd",
    },
  );
  assert.deepEqual(
    restoreFunctionCallItem(
      {
        type: "function_call",
        name: namespaceWireName,
        call_id: "call-namespace",
        arguments: "{}",
      },
      request.flatToolMap,
    ),
    {
      type: "function_call",
      namespace: "workspace",
      name: "read_file",
      call_id: "call-namespace",
      arguments: "{}",
    },
  );
});

test("rewrites restored tool-call history for follow-up requests", async () => {
  const { transformRequestBody } = await import(adapterUrl.href);
  const request = transformRequestBody({
    tools: [
      { type: "custom", name: "exec", description: "Run a command" },
      {
        type: "namespace",
        name: "workspace",
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
    input: [
      {
        type: "custom_tool_call",
        call_id: "call-custom",
        name: "exec",
        input: "pwd",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call-custom",
        name: "exec",
        output: "ok",
      },
      {
        type: "function_call",
        call_id: "call-namespace",
        namespace: "workspace",
        name: "read_file",
        arguments: JSON.stringify({ path: "README.md" }),
      },
      {
        type: "function_call_output",
        call_id: "call-namespace",
        output: "contents",
      },
    ],
  });

  const [customTool, namespaceTool] = request.body.tools;
  assert.deepEqual(request.body.input, [
    {
      type: "function_call",
      call_id: "call-custom",
      name: customTool.name,
      arguments: JSON.stringify({ input: "pwd" }),
    },
    {
      type: "function_call_output",
      call_id: "call-custom",
      output: "ok",
    },
    {
      type: "function_call",
      call_id: "call-namespace",
      name: namespaceTool.name,
      arguments: JSON.stringify({ path: "README.md" }),
    },
    {
      type: "function_call_output",
      call_id: "call-namespace",
      output: "contents",
    },
  ]);
});

test("rewrites forced custom tool_choice when custom tools are flattened", async () => {
  const { transformRequestBody } = await import(adapterUrl.href);
  const request = transformRequestBody({
    tools: [{ type: "custom", name: "exec", description: "Run a command" }],
    tool_choice: { type: "custom", name: "exec" },
  });

  assert.deepEqual(request.body.tool_choice, {
    type: "function",
    name: request.body.tools[0].name,
  });
});

test("rewrites namespaced allowed tool_choice entries through flattened tools", async () => {
  const { transformRequestBody } = await import(adapterUrl.href);
  const request = transformRequestBody({
    tools: [
      { type: "function", name: "standalone", parameters: { type: "object", properties: {} } },
      {
        type: "namespace",
        name: "workspace",
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "function", namespace: "workspace", name: "read_file" },
        { type: "function", name: "standalone" },
        { type: "web_search_preview" },
      ],
    },
  });

  assert.deepEqual(request.body.tool_choice, {
    type: "allowed_tools",
    mode: "required",
    tools: [
      { type: "function", name: request.body.tools[1].name },
      { type: "function", name: "standalone" },
      { type: "web_search_preview" },
    ],
  });
});

test("preserves scalar and unrelated tool_choice values", async () => {
  const { transformRequestBody } = await import(adapterUrl.href);
  for (const tool_choice of ["auto", "required", "none"]) {
    assert.equal(
      transformRequestBody({
        tools: [{ type: "custom", name: "exec", description: "Run a command" }],
        tool_choice,
      }).body.tool_choice,
      tool_choice,
    );
  }

  const unrelatedChoice = { type: "function", name: "standalone" };
  assert.equal(
    transformRequestBody({
      tools: [{ type: "custom", name: "exec", description: "Run a command" }],
      tool_choice: unrelatedChoice,
    }).body.tool_choice,
    unrelatedChoice,
  );
});

test("keeps parallel tool outputs adjacent when assistant text arrives first", async () => {
  const { transformRequestBody } = await import(adapterUrl.href);
  const request = transformRequestBody({
    tools: [
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    ],
    input: [
      {
        type: "function_call",
        call_id: "call-a",
        name: "read_file",
        arguments: JSON.stringify({ path: "a.md" }),
      },
      {
        type: "function_call",
        call_id: "call-b",
        name: "read_file",
        arguments: JSON.stringify({ path: "b.md" }),
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Reading both files." }],
      },
      { type: "function_call_output", call_id: "call-a", output: "A" },
      { type: "function_call_output", call_id: "call-b", output: "B" },
    ],
  });

  assert.deepEqual(
    request.body.input.map((item) => [item.type, item.call_id]),
    [
      ["function_call", "call-a"],
      ["function_call", "call-b"],
      ["function_call_output", "call-a"],
      ["function_call_output", "call-b"],
      ["message", undefined],
    ],
  );
});

test("leaves incomplete parallel tool history unchanged", async () => {
  const { transformRequestBody } = await import(adapterUrl.href);
  const input = [
    {
      type: "function_call",
      call_id: "call-a",
      name: "read_file",
      arguments: JSON.stringify({ path: "a.md" }),
    },
    {
      type: "function_call",
      call_id: "call-b",
      name: "read_file",
      arguments: JSON.stringify({ path: "b.md" }),
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Still waiting for one result." }],
    },
    { type: "function_call_output", call_id: "call-a", output: "A" },
  ];

  const request = transformRequestBody({ input });

  assert.deepEqual(request.body.input, input);
});

test("coalesces streamed custom tool output before forwarding to LiteLLM", async () => {
  const { transformRequestBody } = await import(adapterUrl.href);
  const request = transformRequestBody({
    tools: [{ type: "custom", name: "exec", description: "Run a script" }],
    input: [
      {
        type: "custom_tool_call",
        call_id: "call-exec",
        name: "exec",
        input: "notify('first'); notify('second')",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Running the script." }],
      },
      { type: "custom_tool_call_output", call_id: "call-exec", output: "first" },
      { type: "custom_tool_call_output", call_id: "call-exec", output: "second" },
    ],
  });

  assert.deepEqual(
    request.body.input.map((item) => [item.type, item.call_id, item.output]),
    [
      ["function_call", "call-exec", undefined],
      ["function_call_output", "call-exec", "first\nsecond"],
      ["message", undefined, undefined],
    ],
  );
});

test("forwards to a configured Responses bridge with independent authentication", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  let received;
  const server = createAdapterServer({
    upstreamUrl: "http://litellm:4000/v1/responses",
    upstreamApiKey: "bridge-key",
    clientApiKey: "provider-key",
    fetchImpl: async (url, init) => {
      received = { url, init };
      return new Response(
        JSON.stringify({
          id: "resp_1",
          output: [],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 80 },
            output_tokens: 1,
            total_tokens: 101,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const unauthorized = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "hello" }),
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
  assert.equal(received, undefined);

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer provider-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "hello" }),
  });

  assert.equal(response.status, 200);
  assert.equal(received.url, "http://litellm:4000/v1/responses");
  assert.equal(received.init.headers.authorization, "Bearer bridge-key");
  assert.deepEqual((await response.json()).usage.input_tokens_details, { cached_tokens: 80 });
});

test("requires the upstream key from clients when no separate client key is configured", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  let forwarded = false;
  const server = createAdapterServer({
    upstreamApiKey: "upstream-key",
    clientApiKey: "   ",
    fetchImpl: async () => {
      forwarded = true;
      return new Response(JSON.stringify({ id: "resp_1", output: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const unauthorized = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test-model", input: "hello" }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(forwarded, false);

  const authorized = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer upstream-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "test-model", input: "hello" }),
  });
  assert.equal(authorized.status, 200);
  assert.equal(forwarded, true);
});

test("restores custom tool items and input deltas in streaming responses", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: wireName,
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_1",
          delta: '{"input":"pw',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_1",
          delta: 'd"}',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "fc_1",
          name: wireName,
          arguments: '{"input":"pwd"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: wireName,
            arguments: '{"input":"pwd"}',
          },
        },
        { type: "response.completed", response: { id: "resp_1" } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: true,
      input: "run pwd",
      tools: [{ type: "custom", name: "exec", description: "Run a command" }],
    }),
  });
  const events = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events[0].item.type, "custom_tool_call");
  assert.equal(events[0].item.name, "exec");
  assert.deepEqual(
    events.filter((event) => event.type === "response.custom_tool_call_input.delta"),
    [
      {
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        item_id: "fc_1",
        delta: "pw",
      },
      {
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        item_id: "fc_1",
        delta: "d",
      },
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "response.custom_tool_call_input.done"),
    [
      {
        type: "response.custom_tool_call_input.done",
        output_index: 0,
        item_id: "fc_1",
        input: "pwd",
      },
    ],
  );
  assert.equal(events[4].item.type, "custom_tool_call");
  assert.equal(events[4].item.input, "pwd");
});

test("restores namespaced function_call_arguments.done names in streaming responses", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_workspace",
            type: "function_call",
            call_id: "call_workspace",
            name: wireName,
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "fc_workspace",
          name: wireName,
          arguments: '{"path":"README.md"}',
        },
        { type: "response.completed", response: { id: "resp_workspace" } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: true,
      input: "read file",
      tools: [
        {
          type: "namespace",
          name: "workspace",
          tools: [
            {
              type: "function",
              name: "read_file",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    }),
  });
  const events = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.deepEqual(events[0].item, {
    id: "fc_workspace",
    type: "function_call",
    call_id: "call_workspace",
    namespace: "workspace",
    name: "read_file",
    arguments: "",
  });
  assert.deepEqual(events[1], {
    type: "response.function_call_arguments.done",
    output_index: 0,
    item_id: "fc_workspace",
    namespace: "workspace",
    name: "read_file",
    arguments: '{"path":"README.md"}',
  });
});

test("recognizes SSE upstream content type case-insensitively", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_case",
            type: "function_call",
            call_id: "call_case",
            name: wireName,
            arguments: '{"input":"pwd"}',
          },
        },
        { type: "response.completed", response: { id: "resp_case" } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "Text/Event-Stream; charset=utf-8" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: true,
      input: "run pwd",
      tools: [{ type: "custom", name: "exec", description: "Run a command" }],
    }),
  });
  const events = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events[0].item.type, "custom_tool_call");
  assert.equal(events[0].item.name, "exec");
  assert.equal(events[0].item.input, "pwd");
});

test("incrementally decodes escaped custom tool input deltas across chunks", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_escaped",
            type: "function_call",
            call_id: "call_escaped",
            name: wireName,
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_escaped",
          delta: '{"input":"line',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_escaped",
          delta: "\\nsmile: \\uD83D",
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_escaped",
          delta: '\\uDE00"}',
        },
        { type: "response.completed", response: { id: "resp_escaped" } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: true,
      input: "run escaped input",
      tools: [{ type: "custom", name: "exec", description: "Run a command" }],
    }),
  });
  const events = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.deepEqual(
    events.filter((event) => event.type === "response.custom_tool_call_input.delta"),
    [
      {
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        item_id: "fc_escaped",
        delta: "line",
      },
      {
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        item_id: "fc_escaped",
        delta: "\nsmile: ",
      },
      {
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        item_id: "fc_escaped",
        delta: "😀",
      },
    ],
  );
});

test("flushes lone high surrogates from streamed custom tool input", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const streamedArguments = [
    ["fc_plain", '{"input":"\\uD800x"}'],
    ["fc_escape", '{"input":"\\uD800\\n"}'],
    ["fc_close", '{"input":"\\uD800"}'],
  ];
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      const events = streamedArguments.flatMap(([itemId, argumentsValue], outputIndex) => [
        {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            id: itemId,
            type: "function_call",
            call_id: `call_${itemId}`,
            name: wireName,
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: outputIndex,
          item_id: itemId,
          delta: argumentsValue,
        },
        {
          type: "response.function_call_arguments.done",
          output_index: outputIndex,
          item_id: itemId,
          name: wireName,
          arguments: argumentsValue,
        },
      ]);
      events.push({ type: "response.completed", response: { id: "resp_lone_surrogates" } });
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: true,
      input: "run lone surrogate inputs",
      tools: [{ type: "custom", name: "exec", description: "Run a command" }],
    }),
  });
  const events = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.deepEqual(
    events
      .filter((event) => event.type === "response.custom_tool_call_input.delta")
      .map((event) => [event.item_id, event.delta]),
    [
      ["fc_plain", "\uD800x"],
      ["fc_escape", "\uD800\n"],
      ["fc_close", "\uD800"],
    ],
  );
});

test("uses final streamed custom tool arguments JSON for escaped input keys", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_escaped_key",
            type: "function_call",
            call_id: "call_escaped_key",
            name: wireName,
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_escaped_key",
          delta: '{"in\\u0070ut":"pw',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "fc_escaped_key",
          name: wireName,
          arguments: '{"in\\u0070ut":"pwd"}',
        },
        { type: "response.completed", response: { id: "resp_escaped_key" } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: true,
      input: "run pwd",
      tools: [{ type: "custom", name: "exec", description: "Run a command" }],
    }),
  });
  const events = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.deepEqual(
    events.filter((event) => event.type === "response.custom_tool_call_input.delta"),
    [],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "response.custom_tool_call_input.done"),
    [
      {
        type: "response.custom_tool_call_input.done",
        output_index: 0,
        item_id: "fc_escaped_key",
        input: "pwd",
      },
    ],
  );
});

test("preserves malformed final streamed custom tool arguments as raw custom input", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_truncated",
            type: "function_call",
            call_id: "call_truncated",
            name: wireName,
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_truncated",
          delta: '{"input":"pw',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "fc_truncated",
          name: wireName,
          arguments: '{"input":"pw',
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: true,
      input: "run pwd",
      tools: [{ type: "custom", name: "exec", description: "Run a command" }],
    }),
  });

  assert.equal(response.status, 200);
  const events = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
  assert.deepEqual(
    events.filter((event) => event.type === "response.custom_tool_call_input.done"),
    [
      {
        type: "response.custom_tool_call_input.done",
        output_index: 0,
        item_id: "fc_truncated",
        input: '{"input":"pw',
      },
    ],
  );
});

test("validates final custom tool arguments independently from streamed deltas", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const maxCustomToolArgumentBytes = 32;
  const server = createAdapterServer({
    maxCustomToolArgumentBytes,
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      const oversized = body.input !== "within-limit";
      const argumentsValue = JSON.stringify({ input: "x".repeat(oversized ? 32 : 16) });
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_limit",
            type: "function_call",
            call_id: "call_limit",
            name: wireName,
            arguments: "",
          },
        },
      ];
      if (body.input !== "oversized-without-delta") {
        events.push({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_limit",
          delta: oversized ? '{"input":"ok"}' : argumentsValue,
        });
      }
      events.push(
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "fc_limit",
          name: wireName,
          arguments: argumentsValue,
        },
        { type: "response.completed", response: { id: "resp_limit" } },
      );
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/responses`;
  const request = (input) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        stream: true,
        input,
        tools: [{ type: "custom", name: "exec", description: "Run a command" }],
      }),
    });

  const withinLimit = await request("within-limit");
  assert.equal(withinLimit.status, 200);
  assert.match(await withinLimit.text(), /response\.custom_tool_call_input\.done/);

  for (const input of ["oversized-with-delta", "oversized-without-delta"]) {
    const response = await request(input);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "custom_tool_arguments_too_large" });
  }
});

test("rejects non-streaming custom tool arguments above the configured byte limit", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxCustomToolArgumentBytes: 24,
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      return Response.json({
        id: "resp_non_stream_limit",
        object: "response",
        output: [
          {
            id: "fc_non_stream_limit",
            type: "function_call",
            call_id: "call_non_stream_limit",
            name: wireName,
            arguments: JSON.stringify({ input: "x".repeat(32) }),
          },
        ],
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "provider-model",
      stream: false,
      input: "run command",
      tools: [{ type: "custom", name: "exec", description: "Run a command" }],
    }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "custom_tool_arguments_too_large" });
});

test("rejects streamed custom tool arguments above the configured byte limit", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxCustomToolArgumentBytes: 24,
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const wireName = body.tools[0].name;
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_large",
            type: "function_call",
            call_id: "call_large",
            name: wireName,
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_large",
          delta: '{"input":"',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_large",
          delta: "x".repeat(64),
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      stream: true,
      input: "run large input",
      tools: [{ type: "custom", name: "exec", description: "Run a command" }],
    }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "custom_tool_arguments_too_large" });
});

test("rejects oversized buffered non-SSE upstream responses", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async () =>
      new Response("", {
        headers: {
          "content-type": "application/json",
          "content-length": String(8 * 1024 * 1024 + 1),
        },
      }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "hello" }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "upstream_response_too_large" });
});

test("rejects oversized held SSE output before committing headers", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async () =>
      new Response(`: ${"x".repeat(8 * 1024 * 1024)}\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "hello", stream: true }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "upstream_response_too_large" });
});

test("rejects a complete oversized SSE line before parsing it", async () => {
  const { splitSseChunkLines } = await import(adapterUrl.href);

  assert.throws(
    () => splitSseChunkLines(`data: ${"x".repeat(8 * 1024 * 1024)}\n\n`, { buffer: "" }),
    /upstream response exceeds buffered limit/,
  );
});

test("rejects an oversized combined SSE buffer before splitting complete events", async () => {
  const { splitSseChunkLines } = await import(adapterUrl.href);

  assert.throws(
    () =>
      splitSseChunkLines(`data: ${"x".repeat(1024)}\n\n`, {
        buffer: `data: ${"x".repeat(8 * 1024 * 1024 - 512)}`,
      }),
    /upstream response exceeds buffered limit/,
  );
});

test("keeps normal multi-line SSE chunks split without retaining complete lines", async () => {
  const { splitSseChunkLines } = await import(adapterUrl.href);
  const state = { buffer: "" };

  assert.deepEqual(
    splitSseChunkLines(
      'event: response.created\ndata: {"type":"response.created"}\n\ndata:',
      state,
    ),
    ["event: response.created", 'data: {"type":"response.created"}', ""],
  );
  assert.deepEqual(splitSseChunkLines(' {"type":"response.completed"}\n\n', state), [
    'data: {"type":"response.completed"}',
    "",
  ]);
  assert.deepEqual(state, { buffer: "", bufferBytes: 0 });
});

test("cancels an oversized unterminated SSE record and returns 413 before commit", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const encoder = new TextEncoder();
  let markCanceled;
  const canceled = new Promise((resolve) => {
    markCanceled = resolve;
  });
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${"x".repeat(8 * 1024 * 1024)}`));
          },
          cancel(reason) {
            markCanceled(reason);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "hello", stream: true }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "upstream_response_too_large" });
  assert.match((await canceled).message, /upstream response exceeds buffered limit/);
});

test("cancels an oversized unterminated SSE record after commit", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const encoder = new TextEncoder();
  let markCanceled;
  const canceled = new Promise((resolve) => {
    markCanceled = resolve;
  });
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"type":"response.output_text.delta","delta":"started"}\n\n'),
            );
            setTimeout(() => {
              controller.enqueue(encoder.encode(`data: ${"x".repeat(8 * 1024 * 1024)}`));
            }, 10);
          },
          cancel(reason) {
            markCanceled(reason);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "hello", stream: true }),
  });

  assert.equal(response.status, 200);
  await assert.rejects(response.text());
  assert.match((await canceled).message, /upstream response exceeds buffered limit/);
});

test("replays provider reasoning when Codex omits it from tool history", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const receivedBodies = [];
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      receivedBodies.push(body);
      if (receivedBodies.length > 1) {
        return new Response('data: {"type":"response.completed","response":{"id":"resp_2"}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }

      const wireName = body.tools[0].name;
      const reasoning = {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Check the requested command first." }],
      };
      const call = {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: wireName,
        arguments: '{"input":"pwd"}',
      };
      const events = [
        { type: "response.output_item.added", output_index: 0, item: reasoning },
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          item_id: "rs_1",
          delta: "Check the requested command first.",
        },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_item.added", output_index: 1, item: call },
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.completed", response: { id: "resp_1" } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/responses`;
  const tools = [{ type: "custom", name: "exec", description: "Run a command" }];

  const firstResponse = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer client-a",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      prompt_cache_key: "thread-1",
      stream: true,
      input: "run pwd",
      tools,
    }),
  });
  await firstResponse.text();

  const secondResponse = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer client-a",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      prompt_cache_key: "thread-1",
      stream: true,
      tools,
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "exec",
          input: "pwd",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: "/workspace",
        },
      ],
    }),
  });
  await secondResponse.text();

  assert.deepEqual(
    receivedBodies[1].input.map((item) => item.type),
    ["reasoning", "function_call", "function_call_output"],
  );
  assert.equal(receivedBodies[1].input[0].summary[0].text, "Check the requested command first.");

  const otherThreadResponse = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer client-a",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      prompt_cache_key: "thread-2",
      stream: true,
      tools,
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "exec",
          input: "pwd",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: "/workspace",
        },
      ],
    }),
  });
  await otherThreadResponse.text();
  assert.deepEqual(
    receivedBodies[2].input.map((item) => item.type),
    ["function_call", "function_call_output"],
  );

  const otherClientResponse = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer client-b",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      prompt_cache_key: "thread-1",
      stream: true,
      tools,
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "exec",
          input: "pwd",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: "/workspace",
        },
      ],
    }),
  });
  await otherClientResponse.text();
  assert.deepEqual(
    receivedBodies[3].input.map((item) => item.type),
    ["function_call", "function_call_output"],
  );
});

test("rejects invalid numeric configuration", async () => {
  const { createAdapterServer } = await import(adapterUrl.href);
  assert.throws(
    () => createAdapterServer({ maxInternalErrorAttempts: 0 }),
    /INTERNAL_ERROR_ATTEMPTS must be an integer between 1 and 100/,
  );
  assert.throws(
    () => createAdapterServer({ maxRequestBytes: Number.NaN }),
    /MAX_REQUEST_BYTES must be an integer between 1 and 67108864/,
  );
  assert.throws(
    () => createAdapterServer({ maxCustomToolArgumentBytes: 8 * 1024 * 1024 + 1 }),
    /maxCustomToolArgumentBytes must be an integer between 1 and 8388608/,
  );
  assert.throws(
    () => createAdapterServer({ upstreamTimeoutMs: Number.POSITIVE_INFINITY }),
    /UPSTREAM_TIMEOUT_MS must be an integer between 1 and 2147483647/,
  );
  assert.throws(
    () => createAdapterServer({ internalErrorRetryDelayMs: 2_147_483_648 }),
    /INTERNAL_ERROR_RETRY_DELAY_MS must be an integer between 0 and 2147483647/,
  );
  assert.throws(
    () =>
      createAdapterServer({
        maxInternalErrorAttempts: 3,
        internalErrorRetryDelayMs: 1_073_741_824,
      }),
    /INTERNAL_ERROR_RETRY_DELAY_MS is too large for the configured retry attempts/,
  );
});

test("times out a stalled upstream request", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    upstreamTimeoutMs: 10,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello" }),
  });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "upstream_timeout" });
});

test("aborts the upstream request when the client disconnects", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  let markStarted;
  let markAborted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  const server = createAdapterServer({
    fetchImpl: async (_url, init) => {
      markStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            markAborted();
            reject(init.signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const req = http.request({
    host: "127.0.0.1",
    port: address.port,
    path: "/responses",
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  req.on("error", () => {});
  req.end(JSON.stringify({ input: "hello" }));
  await started;
  req.destroy();
  await aborted;

  const health = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(health.status, 200);
});

test("terminates a committed response when the upstream stream fails", async (t) => {
  const { createAdapterServer } = await import(adapterUrl.href);
  const encoder = new TextEncoder();
  const server = createAdapterServer({
    maxInternalErrorAttempts: 1,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"type":"response.output_text.delta","delta":"started"}\n\n'),
            );
            setTimeout(() => controller.error(new Error("upstream disconnected")), 10);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello", stream: true }),
  });
  assert.equal(response.status, 200);
  await assert.rejects(response.text());

  const health = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(health.status, 200);
});

test("rejects request bodies above the configured byte limit", async (t) => {
  assert.equal(existsSync(fileURLToPath(adapterUrl)), true);
  const { createAdapterServer } = await import(adapterUrl.href);
  const server = createAdapterServer({
    maxRequestBytes: 32,
    fetchImpl: async () => {
      throw new Error("oversized requests must not reach the upstream");
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/responses",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ input: "x".repeat(64) }));
  });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(JSON.parse(response.body), { error: "request_too_large" });
});
