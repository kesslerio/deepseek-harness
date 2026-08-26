# Agent Note: 分离 pi-ai 首事件计时与请求关联

Status: implemented

[English](2026-08-25-pi-ai-first-event-timeout-correlation.md) | 中文

## 问题

`dsh-llm-pi-ai` 对第一个尚未解析的 Harness 流分片和之后每个尚未解析的分片都应用 `streamIdleTimeoutMs`。长上下文请求在产生第一个分片前，可能在提供方队列或 prefill 中花费远长于活跃解码分片间允许静默的时间，因此单一间隔要么过早拒绝健康的长 prefill 工作，要么让已停滞的活跃流等待过久。失败也缺少外发请求标识符，无法把 Harness 超时与网关和模型服务器日志关联起来。

## 决策

每个 pi-ai 提供方 profile 接受 `firstEventTimeoutMs`：它必须是正的有限 Node timer 延迟，默认使用该 profile 解析后的 `streamIdleTimeoutMs`。适配器为第一次受保护的流需求使用首事件间隔和 `LLM_FIRST_EVENT_TIMEOUT`；第一个 Harness 分片解析后，同一个稳定 abort 信号会为后续需求使用 `streamIdleTimeoutMs` 和 `LLM_STREAM_IDLE_TIMEOUT`。首事件到期报告 `pi-ai first event timeout after <ms>ms`；后续到期保留 `pi-ai stream idle timeout after <ms>ms`。两者都映射到公开 `TIMEOUT` code，并中止 SDK 请求。

适配器为每次 `stream()` 请求生成一个 UUID，通过 `X-Request-Id` 发送，并覆盖配置中任何大小写不敏感的同名 header。提供方终止的 error 和 aborted 分片，以及适配器自有的首事件和空闲超时失败，都在 `LlmFailure.requestId` 中保留同一个值。该标识符仅用于诊断，不进入成功助手内容或回放状态。

## 考虑过的替代方案

**为整个响应提高 `streamIdleTimeoutMs`。** 否决，因为足以容纳排队长上下文 prefill 的上限，也会推迟活跃响应停止推进后的检测与清理。

**自动重试每次首事件超时。** 否决，因为未观察到的请求仍可能占用提供方容量，替代请求会放大同一队列。重试仍由显式提供方 profile 策略负责，不进入适配器的单次请求传输行为。

**使用配置的静态请求标识符。** 否决，因为并发请求和重试会共享同一个值，无法分别关联。

## 影响

长 prefill 部署可以设置更大的首事件窗口，同时保留更短的活跃流空闲上限。省略 `firstEventTimeoutMs` 的 profile 保持原有单间隔行为。运维人员可以通过一个标识符把 Harness 终止失败关联到确切外发请求；成功响应只增加一个 HTTP header，不增加持久化会话字段。

## 测试

超时原语测试在同一稳定信号上区分第一次需求和后续空闲到期。pi-ai 适配器测试证明 profile 默认值与校验、较长首事件等待后的正常流式响应、首事件超时分类、请求清理、大小写不敏感的 header 所有权、每次请求唯一 UUID，以及失败与 header 的关联。
