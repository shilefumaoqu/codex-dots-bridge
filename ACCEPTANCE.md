# 0.2.0-alpha.31：验收与限制 / Acceptance and limits

发布准备日期：2026-10-23。Windows x64 实验性 alpha，在 alpha.30 基线上合入连接拒绝恢复及接单工具结果诊断。独立云端到本地对话通道候选未合入。

## 本版内容

- 配套基于官方 Tunnel v0.0.17 的本地修改版 `0.0.17-local-refusal.1+a248b7f-local-refusal`。修复 Windows 连接拒绝分类和启动 OAuth 发现拒绝后的恢复；启动窗口固定，不新增业务重放或自动重启。
- Bridge 默认启用30秒启动等待，新增结构化 starting/ready/auth_required/failed/unknown 判断。readyz200与工具执行、任务完成、用户收到回复分别核验。
- 八个接单工具新增私有 tool_finished 阶段和白名单错误分类。回调正常返回不代表任务成功；诊断异常不重执行业务，不记录消息、响应正文、秘密或错误详情。

## 复用的独立候选证据

这些证据来自发布前独立候选，不替代本次合并与最终安装包验证。

- Windows 实际客户端初始拒绝及 OAuth 单独拒绝后原进程恢复；永久拒绝达到窗口后终止该恢复分支。正常、429、503及业务响应上传失败防重均有隔离证据。
- 22项正式EXE隔离场景、8项HTTP/MCP/SQLite场景134断言通过。业务响应上传失败仍只执行业务一次。
- Tunnel/Bridge候选类型检查、构建和定向检查通过；相关回归70通过、10跳过。9项需真实Codex安装环境，1项旧chat目录夹具与alpha.30基线不兼容；不记为通过。
- P0候选相关协议/任务/聊天回归70通过、1跳过，覆盖并发错序、HTTP提前关闭、观察失败、SDK拒绝、秘密哨兵等。
- 两批候选均有指定 `gpt-6.1-sol / high` 的专门审查。Tunnel首轮1项状态优先级问题已修复并经独立定向复核；未独立核实模型后台路由。

## 本次发布验证

合并源码类型检查与构建通过；定向回归83通过、1跳过、0失败（84项）；发布检查38/38。包装防护5/5、Windows Git换行及归档摘要检查2/2、普通临时目录安装护栏检查通过。公开脚本重建的Tunnel EXE与已验收冻结SHA256一致。最终ZIP/Setup、安装升级与发布前专门审查结果在同版本Release正文补充；此处不以候选测试替代成品验收。alpha.30历史远端CI有35/38失败，本版远端CI单独报告。

## 尚未解决及验证边界

1. ChatGPT→Dot连续聊天及普通caller曾出现Events HTTP200后零领取/无回复。平台逐事件规则、run、原生会话关联不足，根因未知；本版不宣称修复旧失败。
2. SDK回调前拒绝、进程崩溃、持续日志失败仍可能缺少完成记录。没有日志不能直接判断业务未执行。
3. 真实忙碌/下一回合、中断、Windows自然重启自启、长期运行和跨用户场景仍缺完整验收；current_turn不支持。独立对话通道候选的行为未在此版启用。
4. Linux云端构建只验证源码开发条件，不验证Windows EXE、托盘、安装器或本机原生会话。GitHub发布、Codex环境发布、本机服务升级和真实消息实收是独立状态。
5. 本次发布不更新当前运行服务，不重发消息、不修改订阅，不恢复旧任务。私有核验材料、数据库、真实配置与凭据均不公开。

## 分发与第三方身份

Setup未签名，包含Node24.21.0及本地修补Tunnel；后者不是OpenAI官方原版。保留上游许可、NOTICE与依赖材料，固定上游源码及补丁可用于重建。使用者需要自己的账号、Tunnel权限与密钥、插件连接和Events订阅。升级保留已有数据及自定义外部客户端配置，按安装器在途保护执行。

## English

This experimental Windows alpha combines connection-refusal recovery and redacted worker tool-result diagnostics on alpha.30. It includes a locally patched Tunnel v0.0.17, not the unmodified official release. Independent candidate tests and dedicated reviews have evidence; final merged-source, package and upgrade checks are reported separately. No business replay or automatic restart was added.

Old Events pickup and chat-reply failures remain unresolved. A callback returning, task completion, response delivery and user receipt are separate facts. Linux cloud checks cannot validate Windows desktop behavior. Publishing does not upgrade the current local service. Private data and credentials are excluded. Setup is unsigned.