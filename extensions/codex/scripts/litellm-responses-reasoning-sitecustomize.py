"""Preserve Responses reasoning items across LiteLLM's Chat conversion."""

from typing import Any


def _get(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else getattr(value, key, None)


def _set(value: Any, key: str, field_value: Any) -> None:
    if isinstance(value, dict):
        value[key] = field_value
    else:
        setattr(value, key, field_value)


def _reasoning_text(item: Any) -> str:
    parts = _get(item, "summary") or _get(item, "content") or []
    if isinstance(parts, str):
        return parts
    if not isinstance(parts, list):
        return ""
    return "".join(
        _get(part, "text") or ""
        for part in parts
        if isinstance(_get(part, "text"), str)
    )


def attach_reasoning_content(input_items: Any, messages: list[Any]) -> list[Any]:
    if not isinstance(input_items, list):
        return messages

    pending_reasoning = ""
    reasoning_by_call_id: dict[str, str] = {}
    for item in input_items:
        if _get(item, "type") == "reasoning":
            pending_reasoning = _reasoning_text(item)
            continue
        if _get(item, "type") != "function_call":
            pending_reasoning = ""
            continue
        if not pending_reasoning:
            continue
        call_id = _get(item, "call_id") or _get(item, "id")
        if isinstance(call_id, str) and call_id:
            reasoning_by_call_id[call_id] = pending_reasoning

    for message in messages:
        if _get(message, "role") != "assistant":
            continue
        tool_calls = _get(message, "tool_calls")
        if not isinstance(tool_calls, list):
            continue
        matched_reasoning = False
        for tool_call in tool_calls:
            call_id = _get(tool_call, "id")
            reasoning = reasoning_by_call_id.get(call_id)
            if reasoning:
                _set(message, "reasoning_content", reasoning)
                matched_reasoning = True
                break
        # DeepSeek thinking mode requires the field even when that tool-call turn
        # emitted zero reasoning tokens; omitting it makes the next turn invalid.
        if not matched_reasoning and _get(message, "reasoning_content") is None:
            _set(message, "reasoning_content", "")
    return messages


def install_litellm_patch() -> None:
    from litellm.responses.litellm_completion_transformation.transformation import (
        LiteLLMCompletionResponsesConfig,
    )

    marker = "_openclaw_reasoning_content_patch"
    if getattr(LiteLLMCompletionResponsesConfig, marker, False):
        return

    original = (
        LiteLLMCompletionResponsesConfig._transform_response_input_param_to_chat_completion_message
    )

    def patched(input: Any) -> list[Any]:
        return attach_reasoning_content(input, original(input))

    LiteLLMCompletionResponsesConfig._transform_response_input_param_to_chat_completion_message = (
        staticmethod(patched)
    )
    setattr(LiteLLMCompletionResponsesConfig, marker, True)


install_litellm_patch()
