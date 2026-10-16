# Agent Note: Legacy Agent preset resume aliases

Status: implemented

[English](2026-10-11-legacy-agent-preset-resume-aliases.md) | 中文

## 问题

会话日志会保留已选 preset ID。升级时若 preset 定义改用了新 ID，冷恢复会按旧 ID 查询注册表并拒绝该会话。

## 决策

preset 注册表接受从已保存 ID 到当前 ID 的显式 `legacyAliases`。若发现请求的 ID 对应的 preset，则优先使用该定义；否则，查找、读取文档、挂载和解析所选默认值时都会解析配置的别名。别名不会出现在 preset 列表中。Web profile 将 `cordis-trimmed` 映射到当前随附的 `cordis` 组合。恢复使用当前的 `cordis` 组合，并保留持久化的会话身份。别名目标不存在以及其他未知 ID 仍会返回 `agent-preset/not-found`。

## 考虑过的替代方案

**改写受影响的会话头。** 单会话数据修复只能恢复这条记录；其他保存了同一旧 ID 的会话仍无法恢复。

**用旧 ID 声明第二个 preset。** 重复的组合会把旧身份作为单独选项发布到列表中，也可能与当前定义不一致。

## 后果

兼容映射明确保留在拥有旧 ID 的 profile 中。现有会话日志无需改写，别名也不会改变当前 preset 列表。其他 ID 仍严格处理：缺失定义或目标不存在的别名会被拒绝。

## 测试

文件系统注册表测试覆盖规范 ID 解析、挂载、优先级、列表省略别名以及未知 ID 拒绝。无密钥 Web Host 快照以报告中的会话 ID 恢复合成的 Session v3 fixture，验证保存的 `cordis-trimmed` 头仍保留，同时在线 Agent 使用 `cordis`。
