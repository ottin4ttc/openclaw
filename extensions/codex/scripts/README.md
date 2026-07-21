# Codex Responses tool compatibility adapter

Some OpenAI-compatible gateways expose Chat Completions, accept only `function`
tools, or both, while Codex requires Responses and emits `custom` and
`namespace` tools. This adapter flattens those tools before forwarding the
request and restores the original Codex response items.

For Baidu `deepseek-v4-pro` and `glm-5.2`, use the bundled LiteLLM bridge. It
routes Codex Responses requests to the Beijing-region Chat Completions endpoint,
where Baidu automatic prefix caching reports
`usage.prompt_tokens_details.cached_tokens`. LiteLLM maps that value back to
Responses `usage.input_tokens_details.cached_tokens`. The Compose file pins the
officially signed LiteLLM v1.92.0 image by digest.

```bash
cd extensions/codex/scripts
export BAIDU_API_KEY='...'
export LITELLM_MASTER_KEY='sk-local-random-value'
docker compose -f compose.responses-tool-compat.yaml up -d --build
```

Keep the Codex provider base URL pointed at `http://127.0.0.1:8046` with
`wire_api = "responses"`. The bridge serves both configured model ids:
`deepseek-v4-pro` and `glm-5.2`.

Build and run the adapter from the repository root:

```bash
docker build \
  -f extensions/codex/scripts/Dockerfile.responses-tool-compat \
  -t openclaw-codex-responses-tool-compat:local \
  extensions/codex/scripts

docker run --rm \
  --name openclaw-codex-baidu-adapter \
  -p 127.0.0.1:8046:8046 \
  openclaw-codex-responses-tool-compat:local
```

Configuration:

- `OPENCLAW_CODEX_RESPONSES_UPSTREAM_URL`: complete upstream Responses URL;
  defaults to `https://qianfan.baidubce.com/v2/responses`.
- `OPENCLAW_CODEX_RESPONSES_UPSTREAM_API_KEY`: optional upstream bearer token.
  When omitted, the adapter forwards the incoming authorization header. When
  configured without a separate client key, clients must present this same key.
- `OPENCLAW_CODEX_RESPONSES_CLIENT_API_KEY`: optional bearer token required from
  adapter clients. It is required implicitly whenever an upstream key is
  configured. The bundled Compose deployment uses `BAIDU_API_KEY` so the adapter
  can authenticate OpenClaw separately from LiteLLM's master key.
- `OPENCLAW_BAIDU_CODEX_ADAPTER_PORT`: listen port; defaults to `8046`.
- `OPENCLAW_BAIDU_CODEX_ADAPTER_MAX_REQUEST_BYTES`: request limit; defaults to
  8 MiB.
- `OPENCLAW_BAIDU_CODEX_INTERNAL_ERROR_ATTEMPTS`: maximum upstream attempts;
  defaults to `3`.
- `OPENCLAW_BAIDU_CODEX_INTERNAL_ERROR_RETRY_DELAY_MS`: base retry delay;
  defaults to `250` ms.
- `OPENCLAW_BAIDU_CODEX_UPSTREAM_TIMEOUT_MS`: total upstream deadline; defaults
  to `600000` ms.
