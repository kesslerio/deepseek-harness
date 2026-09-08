# Agent Note: MTPLX prefill memory recovery

Status: implemented

English | [中文](2026-09-07-mtplx-prefill-recovery.zh.md)

## Problem

MTPLX can reject a long prompt for sustained critical memory pressure during prefill before the advertised context limit. A generic provider error leaves the failed history intact, so continuation repeats a request that cannot fit.

## Decision

The shared [LLM error classifier](../../../../packages/llm/llm/src/error.ts) maps the observed request-sized prefill rejection to context overflow. Existing bounded compaction recovery owns pruning, summarization, and retry. Generic allocation failures, weight-loading failures, and stall watchdog errors do not qualify.

## Alternatives considered

**Retry unchanged:** consumes time without reducing prompt memory demand.

**Classify every GPU error as overflow:** incorrectly attempts summarization for model-loading failures and unrelated engine faults.

## Consequences

An effective memory ceiling can trigger recovery below a catalog token ceiling. Summarization can itself fail if the selected history exceeds available memory, so deployment context limits and early compaction remain necessary. Classifier and pi-ai tests cover the observed rejection and exclusions; the recorded compaction-recovery scenario verifies checkpointing and same-turn continuation.
