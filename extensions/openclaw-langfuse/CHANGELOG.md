# Changelog

## 1.0.0 (2026-03-25)

### Features

- **LLM Tracing**: Full request/response tracing with nested spans (trace > generation > tool spans)
- **Prompt Management**: Fetch and inject prompts from Langfuse Prompt Management into OpenClaw agents
- **Prompt Linking**: Generations are linked to Langfuse prompts (visible in Prompt Observations)
- **Pattern Matching**: Flexible agent matching rules (exact, wildcard prefix, catch-all)
- **Content Redaction**: Optional redaction of prompt/completion content for privacy
- **Custom Tags**: Configurable tags on every trace for filtering
- **Gateway Mode**: Automatic tracing via diagnostic events when running as gateway
- **Graceful Degradation**: Langfuse unavailability does not affect OpenClaw operation
- **Prompt Caching**: TTL-based caching for fetched prompts to minimize latency
- **Template Variables**: Support for `{{agent_name}}`, `{{channel_id}}`, `{{session_key}}`, `{{trigger}}` in prompts
