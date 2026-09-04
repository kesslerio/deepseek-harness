# Agent Note: Process-wide undici egress guards for provider requests

Status: implemented

English | [中文](2026-09-03-llm-pi-ai-undici-egress-guards.zh.md)

## Problem

A production session became unable to compact or continue: every model request larger than roughly 400,000 tokens died at metronomic ~302s with a bare `terminated` transport error, and compaction — which must send the whole conversation to be summarized — failed the same way 23 times, deadlocking the session against its 500,000-token context window. The harness's own watchdogs never fired: `firstEventTimeoutMs` was already 900,000 ms on the affected route, and the serving provider (a two-node vLLM cluster) had already raised its equivalent engine timeout to 1,800 s. Raising either side further changed nothing.

The wall was neither endpoint. Node's global fetch is its built-in undici, and undici arms `headersTimeout` and `bodyTimeout` defaults of 300,000 ms on every exchange. Streaming LLM endpoints emit response headers immediately and then send no body bytes until prefill completes, so any request whose provider needs more than five minutes before its first token is killed mid-flight by the client's own HTTP stack, surfacing as a bare `TypeError: terminated` (cause `UND_ERR_BODY_TIMEOUT`, flattened away by pi-ai's error handling) and classified as retryable TRANSPORT — five identical doomed retries per step. The adapter's own first-event and stream-idle watchdogs were already in place and never fired: they govern time-to-first-chunk, while undici's body default bounds the silent body directly and wins every race against them.

## Decision

`dsh-llm-pi-ai` installs the process-wide fetch dispatcher itself (`src/egress.ts`), built from two new top-level configuration fields, `httpBodyTimeoutMs` and `httpHeadersTimeoutMs`, both defaulting to `0` — disabled. Disabling returns timeout ownership to the adapter's own watchdogs (`firstEventTimeoutMs` / `streamIdleTimeoutMs`), which is the design those fields already encode; a finite value reinstalls a dispatcher-level floor below them. The plugin installs at mount and reinstalls through the settings seam when the values change; the real-composition suite covers both the mount-time install and a provider request routed through the installed guard.

The scope is process-wide by necessity, not preference: pi-ai constructs its OpenAI clients as `new OpenAI({ apiKey, baseURL })` with no fetch seam, so there is no per-request place to attach a dispatcher. The npm `undici` package's `setGlobalDispatcher` governs Node's built-in fetch because both read the same `Symbol.for('undici.globalDispatcher.1')` global store. Non-LLM fetchers are unaffected in practice — the web tool owns its budget through the tool-call timeout policy and abort signals — and the disabled default restores the behavior where each caller's own timeout bounds the exchange instead of an undici default.

## Alternatives considered

**Raise the server-side engine timeout.** Already done in the affected deployment (`VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS=1800`) and proven ineffective: the kill fires in the client process before either endpoint's timeout applies.

**Raise the adapter's first-event timeout.** Also already done (900,000 ms) and ineffective for the same reason — the undici default wins the race against any watchdog, because the watchdog governs time-to-first-chunk while undici bounds the silent body directly.

**Set a finite default (e.g. 1,800,000 ms) instead of disabling.** Rejected: the right bound is deployment- and route-specific and is already expressible per route through the watchdog fields; a dispatcher-level default would re-introduce a second, hidden timeout owner competing with them. `0` keeps one owner per phase.

**Fork pi-ai's OpenAI-completions provider to accept a dispatcher.** Rejected for this change: duplicating a maintained provider implementation to move one option is worse than a documented process-wide dispatcher; the upstream gap is recorded in the package README's Known Limitations (the OpenAI client already supports `fetchOptions`, so a pi-ai passthrough would let these become per-profile fields).

## Consequences

Every fetch in the harness process runs without undici's 300,000 ms headers/body defaults. Consumers that relied on those defaults as an implicit backstop must own their budgets; audited consumers in the harness do (tool-call timeout policy, adapter watchdogs). Behavioral tests pin the two directions — a stalled body survives under the disabled default and aborts with `UND_ERR_BODY_TIMEOUT` under a finite guard, and missing headers abort with `UND_ERR_HEADERS_TIMEOUT` — the real-composition suite proves the guards install at mount and that a provider request through pi-ai's own client honors the configured bound, and a regression test for the original incident (a >300s silent prefill surviving a full provider request) cannot run cheaply; the stalled-body tests exercise the same mechanism at fast-timer granularity. The guards coordinate with `@deepseek-ai/dsh-http-proxy` rather than fight it: when that package has installed a proxy policy it owns undici's global dispatcher, so this adapter yields (installs nothing) and the proxy dispatcher keeps its default timeouts — recorded in the README as a known limitation, since eliminating it would require threading both concerns into one dispatcher.
