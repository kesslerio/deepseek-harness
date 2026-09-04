# Agent Note: 为提供商请求安装进程级 undici 出口防护

Status: implemented

[English](2026-09-03-llm-pi-ai-undici-egress-guards.md) | 中文

## 问题

一个生产会话既无法压缩也无法继续：每个超过约 400,000 token 的模型请求都在精确得可怕的 ~302 秒处以裸 `terminated` 传输错误失败，而压缩——它必须把整段会话发给模型做摘要——以同样的方式失败了 23 次，会话在 500,000 token 的上下文窗口前彻底死锁。Harness 自己的看门狗从未触发：受影响路由的 `firstEventTimeoutMs` 已经是 900,000 ms，服务端（一个双节点 vLLM 集群）的等效引擎超时也早已提到 1,800 秒。任何一端继续调大都毫无作用。

墙不在任何一端。Node 的全局 fetch 是其内置 undici，而 undici 给每个交换默认装上 300,000 ms 的 `headersTimeout` 与 `bodyTimeout`。流式 LLM 端点会立即发出响应头，然后在整个 prefill 期间不发送任何字节，所以任何提供商需要五分钟以上才产出首个 token 的请求都会被客户端自己的 HTTP 栈中途杀掉，表现为裸 `TypeError: terminated`（原因是 `UND_ERR_BODY_TIMEOUT`，被 pi-ai 的错误处理抹平）并被归类为可重试的 TRANSPORT——每步五次一模一样的注定失败的重试。适配器自己的首事件与流空闲看门狗早已就位却从未触发：它们约束的是首块到达前的时间，而 undici 的 body 默认值直接约束静默的 body，在每一次竞争中取胜。

## 决策

`dsh-llm-pi-ai` 自己安装进程级 fetch dispatcher（`src/egress.ts`），由两个新的顶层配置字段 `httpBodyTimeoutMs` 与 `httpHeadersTimeoutMs` 驱动，二者默认 `0`——禁用。禁用把超时所有权还给适配器自己的看门狗（`firstEventTimeoutMs` / `streamIdleTimeoutMs`），这正是这些字段早已表达的设计；有限值则在其下再设一层 dispatcher 级下限。插件在挂载时安装，配置经 settings 接缝变更且值不同时重装；真实组合测试同时覆盖挂载时安装与经已安装防护路由的提供方请求。

作用域之所以是进程级，是必要而非偏好：pi-ai 以 `new OpenAI({ apiKey, baseURL })` 构造其 OpenAI 客户端，没有 fetch 接缝，不存在逐请求挂 dispatcher 的位置。npm `undici` 包的 `setGlobalDispatcher` 之所以能管住 Node 内置 fetch，是因为二者读取同一个 `Symbol.for('undici.globalDispatcher.1')` 全局存储。非 LLM 的 fetch 调用方实际上不受影响——web 工具通过 tool-call 超时策略和 abort signal 自持预算——而禁用默认值恢复了"由调用方自己的超时约束交换过程"的行为，而不是 undici 的默认值。

## 已考虑的替代方案

**调大服务端引擎超时。** 受影响部署已经做了（`VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS=1800`）并被证明无效：击杀发生在客户端进程内，两端的超时都轮不到生效。

**调大适配器的 first-event 超时。** 同样已经做了（900,000 ms）且因同一原因无效——undici 的默认值直接约束静默的 body，而看门狗管的是首块到达前的时间，每次竞争都是 undici 赢。

**设置有限默认值（如 1,800,000 ms）而非禁用。** 否决：正确的界限取决于部署与路由，且已经可以按路由通过看门狗字段表达；dispatcher 级默认值会重新引入第二个隐藏的超时所有者与它们竞争。`0` 让每个阶段只有一个所有者。

**改写 pi-ai 的 OpenAI-completions 提供商以接受 dispatcher。** 本变更中否决：为了挪一个选项而复制一个受维护的提供商实现，不如一个有文档的进程级 dispatcher；上游缺口已记录在包 README 的 Known Limitations（OpenAI 客户端已支持 `fetchOptions`，pi-ai 若透传即可让这些字段变成按 profile 配置）。

## 后果

Harness 进程内的每一次 fetch 都不再受 undici 的 300,000 ms headers/body 默认值约束。曾依赖这些默认值作为隐式兜底的调用方必须自持预算；Harness 内的调用方已经过审计（tool-call 超时策略、适配器看门狗）。行为测试钉死两个方向——禁用默认下停滞的 body 存活，有限防护下以 `UND_ERR_BODY_TIMEOUT` 中止，缺失响应头以 `UND_ERR_HEADERS_TIMEOUT` 中止——真实组合测试证明挂载时安装了防护，且经 pi-ai 自身客户端的提供方请求会遵守配置的界限；针对原始事故（>300 秒静默 prefill 撑过完整提供商请求）的回归测试无法廉价运行，停滞 body 测试以 fast-timer 粒度锻炼同一机制。防护与 `@deepseek-ai/dsh-http-proxy` 协作而非对抗：当该包安装了代理策略时，它拥有 undici 的全局 dispatcher，适配器便让位（不安装任何东西），代理 dispatcher 保留其默认超时——已记入 README 作为已知限制，因为消除它需要把两个关注点打进同一个 dispatcher。
