---
title: Subagent concurrency limit
type: feat
status: active
date: 2026-09-08
origin: null
deepened: null
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

**Target repo:** `deepseek-harness` (the DSH checkout, where this plan and all work live).

# Subagent concurrency limit

## Summary

Add a hard, opt-in cap on how many subagents a single session runs at once. Today the subagent stack has a recursion-depth cap (`maxDepth`) but no parallelism cap, so a skill that fans out 4–8 continuuable children can overwhelm a local LLM. This plan gates continuable admission in the subagent service so a session bound to a capped provider is rejected loudly once a configurable pool (default 2) is full, while every default provider stays uncapped.

---

## Problem Frame

The user runs most work on local LLMs (mlx-serve/oMLX/MTPLX routers on `mac-mtplx` and `mac-dwarfstar`, a few remote routes). Their delegation-heavy skills call `subagent` 4–8 times in a block. DSH enforces `maxDepth` (recursion depth, default 3) but has no cap on concurrent children, so a block of background subagents all spins up a child Agent loop that hammers the local model in parallel. The user wants a session bounded to two subagents at a time. A soft rule ("run at most two") was rejected — they want a guaranteed bound, not model discipline.

---

## Requirements

- **R1.** A session whose delegation tools are bound to a capped provider must reject a continuable `subagent` start with a loud error once the number of its resident continuable children is at or above the cap (default **2**).
- **R2.** The cap counts **all** resident continuable children of the delegating session, regardless of which provider admitted them, so a spawned child and a forked child share one pool (session-wide, not per-provider pools).
- **R3.** A provider that does not declare a cap stays uncapped. The default `spawn`/`fork` providers (registered by `dsh-base`) and the out-of-process providers (ACP, Codex, Claude Code, DSH SDK) are unchanged.
- **R4.** The limit is enforced at continuable **admission**, before the child Agent is materialized; a rejected start creates no child and rolls back cleanly, mirroring the existing `DUPLICATE_CHILD` / `DRAINING` reject-loud behavior.
- **R5.** The web profile registers two capped provider instances and the `cordis-trimmed` preset selects them via its `subagent` / `subagent_fork` tool rows; the default uncapped providers remain registered for every other preset and profile.
- **R6.** Rejection surfaces a stable `SubagentError` code `CONCURRENCY_LIMIT`.

---

## Scope Boundaries

- One-shot foreground delegation is **not** counted or gated. A foreground `subagent` call blocks the model until it returns, so it cannot pile up the way background children do; counting is keyed to continuable activations. (R3)
- Fork children **are** gated (R2), but only when their provider is a capped instance. A plain `fork` provider is unaffected.
- Out-of-process providers are **not** given a cap in this plan; the interface addition is opt-in and they simply omit it. (R3)
- The `headless` profile is not changed here; if the user wants the cap on remote heads too, that is a separate additive row. (Deferred, see below.)

### Deferred to Follow-Up Work

- Capping one-shot foreground delegation (would need a separate admission/registry semaphore, not the continuable path).
- A profile-wide default cap set on the `subagents` service rather than per-provider.
- Capping fork in the `headless` profile if the user wants the bound there too.

---

## Context & Research

### Relevant Code and Patterns

- **`packages/subagent/subagent/src/index.ts` (`SubagentRuntime`)** — the `ctx.subagents` registry and the model-facing `start` / `startContinuable` surface. Providers register by name; a name registers once per process. `registerProvider` throws `DUPLICATE_PROVIDER` on a repeat.
- **`packages/subagent/subagent/src/continuation.ts` (`SubagentContinuationManager`)** — the single continuable-admission funnel. `startContinuable` reserves an id, reads `prepareContinuable`, then inside a per-child lock `materialize`s the Agent and `submitMaterialize`s the prompt. Resident children are held in `activations` (a `SessionId → Activation` map), each carrying `parentSession`.
- **`packages/subagent/subagent/src/types.ts` (`SubagentProvider`, `SubagentCapabilities`)** — the provider contract. `SubagentCapabilities` flags gate the **one-shot** `start()` path; `prepareContinuable` gates continuable.
- **`packages/subagent/subagent-spawn-in-process`** and **`subagent-fork-in-process`** — in-process backends. Each `apply(ctx, config)` builds `new XxxProvider(config.providerName)` and calls `ctx.subagents.registerProvider(...)`. Their `Config` is a `schemastery` `z.object`.
- **`packages/bundle/base/cordis.patch.yml`** — registers the default `spawn` and `fork` providers (`providerName: spawn` / `fork`).
- **`~/.dsh/profiles/web/cordis.patch.yml`** — the user's web profile host patch (the `insert:` block, lines 21–35) is where additive host rows live.
- **`~/.dsh/.agent-presets/cordis-trimmed/agent.cordis.yml`** — the active preset; its `delegation` group points `subagent`/`subagent_fork` at `provider: spawn` / `fork` with `backgroundMode: continuable`.
- Precedent for opt-in capped providers: `packages/experimental/agent-team-profile/cordis.patch.yml` registers extra named provider instances with explicit `maxMembers`/`maxTasks` limits; and the Cordis authoring skill documents "mount a separate host-plane provider row for each instance with a unique `providerName`."

### Key finding that shapes every decision

Continuable children **never reach `SubagentProvider.start()`** — `SubagentRuntime.startContinuable` composes the child itself via the continuation manager, calling only `provider.prepareContinuable`. So a cap that lives in a provider's `start()` would silently not apply to the exact path the user's skills use. The gate must be at admission.

---

## Key Technical Decisions

- **KTD1 [session-settled: user-directed — chose a hard reject-cap over an AGENTS.md guideline: a bound is only a bound if the runtime refuses the call].** Enforce the limit by rejecting admission, not by instructing the model. An instruction can be violated by a model under latency or by an agentic skill; a hard cap cannot.
- **KTD2.** The gate lives in `SubagentContinuationManager.startContinuable`, the single continuable-admission funnel, and counts resident children keyed by the **delegating parent's session id**. This is session-wide (R2) and provider-unifying: one spawn child and one fork child both increment the same parent-scoped count. The named provider's cap supplies the threshold.
- **KTD3.** The cap value is an optional `concurrencyLimit?: number` property on `SubagentProvider` (a plain property, **not** a `SubagentCapabilities` boolean, because it governs continuable admission, not the one-shot `start()` path). The in-process backends read it from their `Config` and expose it on the instance. Default `undefined` = uncapped, so no existing provider changes behavior.
- **KTD4 [session-settled: required by the Cordis two-planes model — the `ctx.subagents` registry is a process singleton where a provider name registers once].** The capped providers are registered **host-side** (an additive row in the web profile patch), and selected **per-preset** by repointing the preset's `subagent`/`subagent_fork` tool rows at `provider: <capped-name>`. Two sessions mounting the preset do not collide because the host registers the provider once, not per mount. Other presets/profiles keep the uncapped default and need no change.

---

## Open Questions

### Resolved During Planning

- **Where to count?** By the delegating parent's session id (`activation.parentSession`), not per-provider. This gives a true session-wide pool across spawn and fork. (KTD2)
- **Why not on the `subagent` tool like `maxDepth`?** `maxDepth` is a per-request value; concurrency is running-state, evaluated against an accumulating count at admission, so it cannot be a per-request field. It belongs on the provider (the thing that admits) and the manager (the thing that counts). (KTD3)
- **Why host-side, not in the preset?** A provider registered in a preset would be registered once per mounted session and collide with `DUPLICATE_PROVIDER` on the second mount. The registry is host-plane by design, so registration is host-plane; selection is preset-plane. (KTD4)

### Deferred to Implementation

- Exact capped-provider naming (e.g. `concurrent-2` vs `spawn-2`).
- Exact reject message text (the code `CONCURRENCY_LIMIT` is fixed; wording is free).
- Whether the config schema should reject `concurrencyLimit ≤ 0` or treat `0` as "uncapped." Recommend: `0` = uncapped, positive int = cap; reject non-integers at config validation.
- Whether the `headless` profile also needs the row (only if the user wants the bound there).

---

## High-Level Technical Design

The new gate is one synchronous check inside `startContinuable`, before the descriptor is snapshotted and `prepareContinuable` is called, so a full pool fails fast with no child and no provider work.

```text
tool-subagent (continuable)
        │
        ▼
SubagentContinuationManager.startContinuable(spec)
        │
  assertAdmitting(parent)              # existing: not draining
        │
  assertChildIdAvailable(childId)      # existing: no duplicate id
        │
  ┌─────▼───────────────────────────────────────────────────────────┐
  │ NEW gate:                                                        │
  │   provider = this.getProvider(spec.provider)                    │
  │   limit    = provider?.concurrencyLimit   # undefined = none    │
  │   inUse    = count of this.activations where                    │
  │              activation.parentSession === parent.id             │
  │   if limit != null && limit > 0 && inUse >= limit:              │
  │       throw new SubagentError(`subagent concurrency limit of    │
  │           ${limit} reached`, 'CONCURRENCY_LIMIT')               │
  └─────┬───────────────────────────────────────────────────────────┘
        │  (rejected: no activation created, no descriptor, no seed)
        ▼
  prepareContinuable(provider) → materialize → submitMaterialized
        │  (unchanged)
        ▼
  { childId, messageId }
```

Data flow of the cap value: `cordis.patch.yml` `concurrencyLimit: 2` → backend `Config` schema → `new SpawnInProcessProvider(name, 2)` → `provider.concurrencyLimit` read by the manager at admission. A provider that omits the field advertises `undefined`, and the manager treats `undefined` as "no cap," so the base path is byte-for-byte unchanged.

---

## Implementation Units

### U1. Concurrency capability on the seam

**Goal:** Add the optional cap to the provider contract so the manager can read it and the backends can publish it, with no change to existing providers.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `packages/subagent/subagent/src/types.ts`
- Test: `packages/subagent/subagent/src/*.test.ts` (type-level: add a `ConcurrencyLimit`/`SubagentProvider` shape test if one exists, or a small smoke test)

**Approach:**
1. Add `readonly concurrencyLimit?: number` to the `SubagentProvider` interface (a plain optional property beside `inheritsParentContext`; do **not** add it to `SubagentCapabilities`, which is the one-shot-only flag set).
2. Carry it through the provider's typert/remote proxy types if the package emits a mirrored proxy interface (grep `SubagentProvider` across the package for a generated duplicate).
3. No default is added at the interface level — `undefined` means "no cap" and is the existing behavior for every current provider.

**Patterns to follow:** How `inheritsParentContext` and the `SubagentCapabilities` flags are declared and mirrored.

**Test scenarios:**
- Happy path: a provider object typed with `concurrencyLimit: 3` satisfies the interface.
- Edge case: a provider object with no `concurrencyLimit` still satisfies the interface (backward compatible).

**Verification:** The package still typechecks and the full `subagent` service test suite passes (the interface change is additive, so nothing should break).

---

### U2. Admission gate in the continuation manager

**Goal:** Reject a continuable start when the delegating session's pool is full.

**Requirements:** R1, R2, R4, R6

**Dependencies:** U1

**Files:**
- Modify: `packages/subagent/subagent/src/continuation.ts`
- Test: `packages/subagent/subagent/src/continuation.test.ts`

**Approach:**
1. In `startContinuable`, immediately after `this.assertChildIdAvailable(childId)` and before `snapshotSubagentDescriptor` / `prepareContinuable`, insert the gate:
   - Read `const provider = this.getProvider(spec.provider)`.
   - Read `const limit = provider?.concurrencyLimit`.
   - Count `inUse` = the number of entries in `this.activations` whose `activation.parentSession === parent.id`.
   - If `limit != null && limit > 0 && inUse >= limit`, `throw new SubagentError(\`subagent concurrency limit of ${limit} reached for session ${parent.id}\`, 'CONCURRENCY_LIMIT')`.
2. The count is a linear scan over `this.activations`; it runs only at admission (once per start), which is cheap relative to materializing an Agent.
3. A rejection happens before any `Agent` is created and before the per-child lock, so there is nothing to roll back and no lifecycle edge is emitted — it is a clean, no-op rejection identical in spirit to `assertChildIdAvailable`.

**Technical design:** Directional — place the check in the synchronous pre-await span of `startContinuable`, alongside `assertChildIdAvailable`, and throw `SubagentError` with code `'CONCURRENCY_LIMIT'`. Do not await anything to take the count, so the check stays atomic with the existing admission reads.

**Patterns to follow:** The existing `assertChildIdAvailable` and `assertAdmitting` rejects in the same method (code `DUPLICATE_CHILD`, `DRAINING`) — same fail-loud posture, no logging side effects.

**Test scenarios:**
- Happy path: with 0 and 1 resident children under a parent, a capped (limit 2) start is admitted.
- Error path: with 2 resident children under a parent (limit 2), the next start throws `SubagentError` with code `CONCURRENCY_LIMIT`, creates no activation, and emits no lifecycle event.
- Edge case — session-wide pool (R2): one spawn child and one fork child both under the same parent count as 2, so a third start (either provider) rejects; a provider with no cap admits beyond 2 (R3).
- Integration: after the 2 resident children settle and their activations are disposed, a subsequent start is admitted again.

**Verification:** The manager unit tests cover the four scenarios above; the existing `startContinuable` behavior is unchanged when no provider carries a cap.

---

### U3. Thread `concurrencyLimit` through the in-process backends

**Goal:** Let the spawn and fork backends accept a `concurrencyLimit` and publish it on the provider instance.

**Requirements:** R3, R5 (config side)

**Dependencies:** U1

**Files:**
- Modify: `packages/subagent/subagent-spawn-in-process/src/index.ts`
- Modify: `packages/subagent/subagent-fork-in-process/src/index.ts`
- Test: each package's `*.test.ts` (config round-trip / provider advertises the cap)

**Approach:**
1. In each backend's `Config` interface and `schemastery` schema, add an optional integer `concurrencyLimit` (recommend: `0` or omitted = uncapped; positive integer = cap; reject non-integers at validation).
2. Pass it into the provider constructor; store it as a readonly field and expose it on the provider so `provider.concurrencyLimit` resolves (KTD3). For spawn: `class SpawnInProcessProvider { constructor(name, concurrencyLimit) ...}`. Mirror for fork.
3. Keep `providerName` defaulting to `spawn` / `fork` so the base-bundle rows are untouched.

**Patterns to follow:** The existing `providerName` config in both backends.

**Test scenarios:**
- Happy path: `new SpawnInProcessProvider('concurrent-2', 2).concurrencyLimit === 2`.
- Edge case: `new SpawnInProcessProvider('spawn')` (omitted) advertises `undefined`.
- Error path: an invalid schema value (e.g. non-integer) fails config validation.

**Verification:** Each backend package's test suite passes; the provider's advertised cap round-trips through the config.

---

### U4. Composition: register capped providers and select them in the preset

**Goal:** Expose the cap at the composition layer — register two capped provider instances host-side and point the active preset's delegation tools at them, leaving the default providers alone.

**Requirements:** R5

**Dependencies:** U2, U3

**Files:**
- Modify: `~/.dsh/profiles/web/cordis.patch.yml` (host-side, additive — the `insert:` block, lines 21–35)
- Modify: `~/.dsh/.agent-presets/cordis-trimmed/agent.cordis.yml` (preset-side tool selection)

**Approach:**
1. In the web profile patch's `insert:` block, add:
   - `name: '@deepseek-ai/dsh-subagent-spawn-in-process'`, `config: { providerName: 'concurrent-2', concurrencyLimit: 2 }`.
   - `name: '@deepseek-ai/dsh-subagent-fork-in-process'`, `config: { providerName: 'concurrent-2-fork', concurrencyLimit: 2 }`.
2. In the `cordis-trimmed` preset `delegation` group, change:
   - `tool-subagent` `provider: spawn` → `provider: concurrent-2`.
   - `tool-subagent-fork` `provider: fork` → `provider: concurrent-2-fork`.
3. Leave the base-bundle `spawn` / `fork` rows (and every other preset) unchanged.

**Important plane note:** The capped provider rows **must** be host-side. Registering them inside a preset would register once per mounted session and collide on the second mount. The profile patch is host composition composed over `dsh-base`, so the provider registers once and is safely selectable by any preset tool.

**Patterns to follow:** The "additional named instance" pattern from `packages/experimental/agent-team-profile/cordis.patch.yml` and the Cordis authoring skill.

**Test scenarios:**
- Integration: mount-validate the preset (`standingKeyFor('cordis-trimmed')`) — it must mount with both capped providers registered and both tool rows selecting them.
- Integration: the default `spawn` / `fork` providers still resolve and are uncapped (a non-capped session can exceed 2 concurrent children).

**Verification:** Mount-validation passes and `ctx.subagents.list()` includes `concurrent-2` and `concurrent-2-fork` alongside `spawn` and `fork`. A real session on `cordis-trimmed` that fires a third concurrent `subagent` sees `CONCURRENCY_LIMIT` (accept AE1); a session that fires two, lets them finish, then fires a third is admitted (accept AE2).

---

## System-Wide Impact

- **Interaction graph:** `SubagentContinuationManager.startContinuable` gains one synchronous read of the named provider plus a linear scan of `this.activations`. No other method is touched. `subagent/start` / `subagent/end` lifecycle events are emitted only for admitted children, so a rejected start emits nothing.
- **Error propagation:** Rejection is a `SubagentError` at admission, identical in shape to the existing `DUPLICATE_CHILD` / `DRAINING` rejects. The tool layer surfaces it as an errored tool result (no run is returned), and no partial child is published.
- **State lifecycle risks:** The count is derived from live `activations` only; one-shot runs are not tracked there, so the gate never counts them. When a child settles its Activation is disposed (removing it from the count), so a released slot is immediately reusable — no leak, no manual reset.
- **API surface parity:** The only new public surface is `SubagentProvider.concurrencyLimit?`, optional and additive. Out-of-process providers that omit it are unaffected; none need changes.
- **Unchanged invariants:** The default `spawn`/`fork` providers stay uncapped; `maxDepth` is untouched; one-shot foreground delegation is still ungated; every preset and profile that does not select a capped provider behaves exactly as today.

---

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| A bug in the gate rejects **all** continuable delegation (not just capped sessions) | Low | High | The gate is a no-op unless `provider.concurrencyLimit` is set and `> 0`. Default providers omit it, so the base path never enters the branch. Covered by U2 test scenarios and the additive-interface property of U1. |
| Registering a second spawn/fork provider collides on a second session mount | Low | Medium | Host-side registration (KTD4) means the provider registers once for the process, not per mount. Mount-validation (U4) and the `DUPLICATE_PROVIDER` guard catch a regression. |
| Counting resident children is off by one under a race between settlement and admission | Low | Medium | The count reads live `activations`; settlement disposes the Activation, so a settling child stops counting. A strict pre-acceptance read (no await inside the gate) keeps the check atomic with the existing admission reads. |
| The user also forks heavily, and fork children exceed the intent | Low | Low | Both tools are capped (R5) and share the pool (R2). Verify with the AE1/AE2 integration scenarios. |

---

## Documentation / Operational Notes

- Update each modified package's README "Configuration" table to list `concurrencyLimit` for `subagent-spawn-in-process` and `subagent-fork-in-process` (the generated configuration catalog is derived from the schema, but the hand-written README is the human-facing source).
- No host, runtime, or user-facing operational change beyond the profile patch; the cap only takes effect on sessions that select a capped provider.

---

## Sources & References

- `packages/subagent/subagent/src/index.ts` — `SubagentRuntime.startContinuable`, `registerProvider`.
- `packages/subagent/subagent/src/continuation.ts` — `SubagentContinuationManager` (the `activations` map, `parentSession`, admission).
- `packages/subagent/subagent/src/types.ts` — `SubagentProvider`, `SubagentCapabilities`.
- `packages/subagent/subagent-spawn-in-process/src/index.ts`, `packages/subagent/subagent-fork-in-process/src/index.ts` — in-process backends and their `Config`.
- `packages/bundle/base/cordis.patch.yml` — default `spawn`/`fork` registration.
- `~/.dsh/profiles/web/cordis.patch.yml` — web profile host patch (`insert:` block).
- `~/.dsh/.agent-presets/cordis-trimmed/agent.cordis.yml` — active preset delegation rows.
- `packages/experimental/agent-team-profile/cordis.patch.yml` — named capped-provider precedent.
- The user's `subagent` tool runs on the `web` profile on the `cordis-trimmed` preset with `backgroundMode: continuable`.
