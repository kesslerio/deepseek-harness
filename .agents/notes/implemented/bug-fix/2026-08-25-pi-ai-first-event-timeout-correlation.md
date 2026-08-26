# Agent Note: Separate pi-ai first-event timing and attempt correlation

Status: implemented

English | [中文](2026-08-25-pi-ai-first-event-timeout-correlation.zh.md)

## Problem

`dsh-llm-pi-ai` applied `streamIdleTimeoutMs` to the first unresolved Harness stream chunk and every later unresolved chunk. A long-context request can spend substantially longer in a provider queue or prefill before its first chunk than an active decode should spend silent between chunks, so one interval either rejected healthy long-prefill work too early or tolerated a stalled active stream for too long. The failure also lacked the outgoing request identifier needed to correlate a Harness timeout with gateway and model-server logs.

## Decision

Each pi-ai provider profile accepts `firstEventTimeoutMs`, a positive finite Node timer delay that defaults to that profile's resolved `streamIdleTimeoutMs`. The adapter gives the first guarded stream demand the first-event interval and `LLM_FIRST_EVENT_TIMEOUT`; after the first Harness chunk resolves, the same stable abort signal uses `streamIdleTimeoutMs` and `LLM_STREAM_IDLE_TIMEOUT` for later demands. First-event expiry reports `pi-ai first event timeout after <ms>ms`; later expiry keeps `pi-ai stream idle timeout after <ms>ms`. Both map to the public `TIMEOUT` code and abort the SDK request.

The adapter generates one UUID for every `stream()` attempt, sends it as `X-Request-Id`, and replaces any case-insensitive configured header collision. Provider-terminal error and aborted chunks, plus adapter-owned first-event and idle timeout failures, retain that same value as `LlmFailure.requestId`. The identifier is diagnostic metadata and does not enter successful assistant content or replay state.

## Alternatives considered

**Raise `streamIdleTimeoutMs` for the whole response.** Rejected because a bound large enough for queued long-context prefill would also delay detection and teardown after an active response stops making progress.

**Retry every first-event timeout automatically.** Rejected because an unobserved request may still occupy provider capacity and a replacement attempt can amplify the same queue. Retry remains an explicit provider-profile policy outside the adapter's single-attempt transport behavior.

**Use a configured static request identifier.** Rejected because concurrent and retried attempts would share one value and could not be correlated independently.

## Consequences

Long-prefill deployments can grant a larger first-event window while retaining a shorter active-stream idle bound. Profiles that omit `firstEventTimeoutMs` preserve the prior single-interval behavior. Operators can join a terminal Harness failure to the exact outgoing attempt through one identifier, while successful responses gain only an HTTP header and no durable session field.

## Testing

The timeout primitive tests distinguish first-demand and later-idle expiry on one stable signal. pi-ai adapter tests prove profile defaulting and validation, a longer first-event wait followed by normal streaming, first-event timeout classification, request teardown, case-insensitive header ownership, unique per-attempt UUIDs, and failure/header correlation.
