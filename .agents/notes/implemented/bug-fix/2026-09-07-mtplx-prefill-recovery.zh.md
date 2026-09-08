# Agent Note: MTPLX 预填充内存恢复

Status: implemented

[English](2026-09-07-mtplx-prefill-recovery.md) | 中文

## Problem

MTPLX 可能在达到声明的上下文上限之前，因预填充期间持续严重内存压力而拒绝长提示词。一般提供商错误会保留失败的历史，因此继续操作会再次发送无法容纳的请求。

## Decision

共享的 [LLM 错误分类器](../../../../packages/llm/llm/src/error.ts) 将已观察到的请求过大导致的预填充拒绝映射为上下文溢出。现有的有限压缩恢复负责裁剪、摘要和重试。一般分配失败、权重加载失败和停滞监控错误不符合条件。

## Alternatives considered

**原样重试：** 消耗时间但不减少提示词的内存需求。

**将所有 GPU 错误归为溢出：** 会对模型加载失败和无关引擎故障错误地尝试摘要。

## Consequences

实际内存上限可以在目录令牌上限之前触发恢复。如果选定历史超过可用内存，摘要本身仍可能失败，因此部署上下文限制和提前压缩依然必要。分类器和 pi-ai 测试覆盖已观察到的拒绝及排除项；录制的 compaction-recovery 场景验证检查点和同轮继续。
