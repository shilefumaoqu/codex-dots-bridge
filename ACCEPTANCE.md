# 0.2.0-alpha.30：验收与限制 / Acceptance and limits

发布准备日期：2026-10-21。Windows x64 实验性 alpha；复用 2026-10-16 已完成本机安装验收的固定程序，不重新打包或安装。

## 本版包含

- 修复启动辅助程序误用系统临时目录导致的编译失败，以及 PowerShell 5 已有启动回执覆盖失败。
- 保留固定 Launcher、登录自启设置、托盘状态窗关闭后重开与按钮刷新修复。
- 官方完整已保存历史读取、增量上下文接续和共享 Tunnel 的最小聊天 send/status 入口。
- 原 worker 入口脱敏阶段日志，区分到达、鉴权、解析、工具回调和 HTTP 结束；不记录正文、请求头、密钥或原始帧。
- 保留单执行槽、忙碌先展示选择、离线/未知跳过、原请求幂等与准确新回合回复关联。

## 已有证据

- alpha.30 构建、实际 PowerShell 5 恢复保护 79 项、后台 helper 22 项、回执覆盖/foreign/ACL 2 项通过。相关修改有指定并报告 `gpt-6.1-sol / high` 的专门审查记录。
- 最终成品有内存 SQLite/模块加载核验、本机升级与任务、订阅、凭据和启动入口保留证据。
- 本次发布复核同一 Setup 哈希；ZIP 与清单对应、3,907 项清单文件及清单自身一致，59 项 npm 许可齐全；公开内容检查未发现问题。
- 本次公开源码 typecheck/build 通过，重编译后的 86 项 dist/scripts 与固定载荷一致；本机发布检查回归 38/38 通过，公开源码与 294 个既有历史 blob 检查无发现。首轮隔离沙箱的 Git 临时目录写入被拒，正常用户环境原测试通过，未为此改断言或产品。远端 CI 结果单独报告。
- 原扩展集成是 **44 通过、1 失败**，不能改写为全绿。后续定位到停止完成与进程退出观察存在时序窗口，仅修正测试与证据采集；相关定向回归及专门复核通过，原历史失败角色仍无法追溯。产品包没有因此重生成。
- alpha.25 的两条本地 caller 自然 Events 样本及既有指定 Codex 精确回合回复属于历史成功，不代替新版 ChatGPT 连续聊天验收。

## 尚未通过或未解决

1. **ChatGPT→Dot 连续聊天未通过。** 新 send/status 工具已被实际调用，但聊天事件 HTTP200 后没有领取/回复，消息过期，第二轮未发送。普通 Codex→Dot 后续对照也出现同类失败；不能声称自动接单目前稳定。
2. HTTP200 只证明接收，不是规则匹配、阿星启动或结果回传。旧事件的运行/会话路由与鉴权前轨迹不足，根因尚未唯一确定。新增日志不能补回旧轨迹。
3. 宿主工具目录变化导致的调用拒绝根因未确认。历史成功不证明该问题消失。
4. 忙碌选择与下一回合、异常中断、真实 Windows 重启后自启、长期运行及跨用户环境仍缺完整实测。当前回合追加不支持，并发默认 1。
5. 原生 Dot/Codex 格式兼容调查单独暂停，不是本版已解决能力。增量上下文新会话接手的实际效率仍待验；完整保存历史不等于恢复压缩前模型上下文或未打开附件。

## 分发说明

安装包未签名，包含 Node 24.21.0 和官方 Tunnel 0.0.16。使用者仍需自己的 Codex/Dot 登录、Tunnel 权限与运行密钥、插件连接和 Events 订阅。升级须遵守原安装器在途保护与数据保留流程。

Setup、Windows ZIP 保持原验收字节；包内文档和部分版本文字为构建时快照。本发布说明和当前仓库补充准确状态，不声称所有门禁或远端 CI 已通过。私有排障记录、真实对话、数据库、配置和凭据不在本次发布中。

## English

This is a **partially validated Windows x64 alpha**, distributing the unchanged installer and payload validated locally on 2026-10-16. It includes startup/helper fixes, tray reopening/refresh fixes, stored-history and incremental handoff support, minimal shared-Tunnel chat tools and redacted worker ingress diagnostics.

The targeted startup checks, dedicated reviews, package checks and local upgrade have evidence. Public-source typecheck/build and 38/38 local release-check tests passed; 86 built runtime/script files match the fixed payload. The public-content/history scan found no issues in 294 existing Git blobs. Sandbox Git fixture writes were denied; unchanged tests passed in the normal user environment. Remote CI is reported separately. The historical expanded integration run was **44 passed / 1 failed**; later directed test fixes and reviews do not turn that old run green. The fixed installer was not regenerated for test-only changes.

**ChatGPT-to-Dot continuous chat has not passed.** Events received HTTP200 but the worker did not pick up the message before expiry. A later ordinary Codex-to-Dot sample failed similarly. Event receipt, service readiness and an active subscription do not prove execution. The old platform routing/pre-authentication trace is unavailable, and the host catalog rejection remains unresolved.

Real busy/next-turn, interrupted waits, a fresh Windows reboot/autostart, long-running and cross-user operation remain incompletely validated. Current-turn steering is unsupported; concurrency defaults to one. Native format compatibility and real incremental-handoff efficiency are not established by this release.

Setup is unsigned and includes Node 24.21.0 and official Tunnel 0.0.16. Login, runtime keys, plugin connection and subscription are user-specific. Package documentation is a build-time snapshot; current release notes supplement it. No fresh cloud round trip or remote CI success is claimed. Private diagnostics, conversations, databases and credentials are excluded.
