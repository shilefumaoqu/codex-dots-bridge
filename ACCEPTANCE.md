# 0.2.0-alpha.32：验收与限制 / Acceptance and limits

发布准备日期：2026-10-23。Windows x64 实验性 alpha，在 alpha.31 基线上修复 Windows 原生链路及 GitHub CI。保留连接拒绝恢复、接单工具结果诊断、托盘、完整历史与增量接续；独立云端到本地对话通道候选未合入。

## 本版内容

- 后台启动、恢复、guardian 与 ACL 检查从 PSHOME 绝对路径显式加载所需内置 PowerShell 模块，避免隔离环境中的模块自动发现问题；保留原超时、权限及防重规则。
- 固定 Launcher 与安装回滚使用 Unicode Shell Link 接口，保留中文目标、参数和工作目录；只读检查已有链接不保存或解析，不改写其字节。
- 安装回滚在原运行目录身份校验失败时立即停止，不进入后续注册或进程变更；保留事务证据。
- 发布历史检查按实际目录身份核对 Git 根，仍拒绝嵌套源码借用父仓库历史。CI 测试按清单验证实际 startup 格式；GitHub hosted Windows runner 的特定 Temp owner 前置处理有独立校验并恢复，不放宽生产保护。
- 配套 Tunnel 仍为基于官方 v0.0.17 的本地修补版 `0.0.17-local-refusal.1+a248b7f-local-refusal`，不是官方原版；不新增业务重放或自动重启。

## 已核验的修复基线

以下是版本更新前源码提交 `f30cbac6ad427fa1ba8e0044e661fb7693d33b20` 的证据，不能替代 alpha.32 最终提交与成品验收。

- [GitHub CI run 39968025799](https://github.com/shilefumaoqu/codex-dots-bridge/actions/runs/39968025799) 全部成功。核心测试 495 项：494 通过、0 失败、1 项既有跳过；双 PowerShell 保护测试、Go 构建、Windows ZIP 与 Setup 构建通过。
- 同一基线 CI 的真实隔离安装验收覆盖正常启动、同版本重装、注入 Commit 失败后的原注册回滚、旧 CLI 移除后的替代 CLI 恢复与后续安装、修改 Skill 阻断升级/卸载、最终卸载和数据保留；生产注册未触及。
- 各功能修复已有指定 `gpt-6.1-sol / high` 的专门审查；实际后端模型路由未独立核实。alpha.32 仅增加版本与文档联动，差异检查另行记录。

## alpha.32 最终产物

alpha.32 的最终提交 CI、Windows ZIP、Setup 与实际上传资产须按本版本独立核对。发布准备阶段尚未生成或验收本版安装器；最终结果以同版本 GitHub Release 正文及资产摘要为准，不借用 alpha.31 安装包或修复基线产物宣称通过。

## 尚未解决及验证边界

1. ChatGPT→Dot 连续聊天及普通 caller 曾出现 Events HTTP 200 后零领取/无回复。平台逐事件规则、run 与原生会话关联不足，根因未知；本版不宣称修复，Events 排查仍暂停。
2. SDK 回调前拒绝、进程崩溃、持续日志失败仍可能缺少完成记录。回调正常返回、任务完成、回复投递和用户收到分别核验；缺少日志不能直接判断业务未执行。
3. 真实忙碌/下一回合、中断、Windows 自然重启自启、长期运行与跨用户场景仍缺完整验收；current_turn 不支持。
4. 修复基线仅测同版本重装与故障回滚，没有传入另一版本安装器，本轮真实跨版本升级未测；不能以同版本重装替代。
5. 本轮未连接真实云端 Tunnel、未做真实消息往返，取消确认 UI 未测。Linux 源码检查不验证 Windows EXE、托盘、安装器或本机原生会话。
6. GitHub 发布、Codex 云端环境更新、本机服务升级和真实消息实收是独立状态。发布准备未操作当前本机服务；不重发消息、不改订阅、不恢复旧任务。私有核验材料、数据库、真实配置与凭据不公开。

## 分发与第三方身份

Setup 未签名，包含 Node 24.21.0 及明确标识的本地修补 Tunnel。保留上游许可、NOTICE 与依赖材料，固定上游源码及补丁可用于重建。使用者需要自己的账号、Tunnel 权限与密钥、插件连接和 Events 订阅。升级保留已有数据及自定义外部客户端配置，并遵守安装器在途保护；实际跨版本兼容结果以该版本实测为准。

## English

This experimental Windows alpha builds on alpha.31 with deterministic PowerShell built-in module loading, Unicode shortcut handling, early rollback identity rejection and CI release/installer acceptance fixes. It retains the locally patched Tunnel v0.0.17; no business replay or automatic restart was added.

The pre-version-update source commit f30cbac passed GitHub CI: 495 core tests, 494 passed, zero failed and one existing skip, plus dual-PowerShell guards, builds and isolated same-version installation/rollback/uninstall checks. These are baseline evidence, not acceptance of the final alpha.32 artifacts. Final commit and artifact results are reported separately in the matching Release.

Events pickup and chat-reply failures remain unresolved. Real cloud operation, natural Windows reboot/autostart, long-term use, cancellation confirmation UI and cross-version upgrades were not verified in this batch. Publishing to GitHub does not update the Codex cloud environment or the current local service. Setup is unsigned; private data and credentials are excluded.
