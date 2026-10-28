<p align="center">
  <img src="docs/素材/星渡/星渡-应用-128.png" width="88" alt="Codex Dots Bridge 图标">
</p>

<h1 align="center">Codex Dots Bridge</h1>

<p align="center">把任务交给你的 Dot，在 Codex 中跟进过程并取回结果。</p>

<p align="center">
  <a href="README.en.md">English</a> · 0.3.0-alpha.1 源码候选（未发布） · Windows x64 · <a href="LICENSE">MIT</a>
</p>

<p align="center">
  <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/download/v0.2.0-alpha.32/Codex-Dots-Bridge-0.2.0-alpha.32-Setup.exe"><strong>下载已发布的 alpha.32 Windows 安装程序</strong></a>
</p>

<p align="center">
  <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/tag/v0.2.0-alpha.32">Windows ZIP、SHA256 校验文件与完整发布说明</a>
</p>

> **当前源码：0.3.0-alpha.1，未发布、未部署的存储升级候选。** 上方下载仍指向已发布的 0.2.0-alpha.32；它不包含本候选改动。本候选增加接纳保护、准确回合后台取回、compact 回执、索引化任务存储、共享读取预算和托盘轻量查询。迁移后的数据库不能由 alpha.32 打开，须按[迁移与验收说明](ACCEPTANCE.md)操作。Events HTTP 200 后零领取仍是独立阻塞项，程序就绪不等于消息往返成功。

Codex Dots Bridge 是连接 Codex 与你已有 Dot 的协作插件。派出一项文本任务后，可以沿同一任务查看进度、回答澄清、补充要求并取回结果。

<p align="center">
  <img src="docs/素材/星渡/bridge-flow.svg" alt="Codex 与 Dot 通过 Codex Dots Bridge 双向协作" width="720">
</p>

## 插件能做什么

| 在 Codex 中 | 你的 Dot 可以 | 结果如何衔接 |
| --- | --- | --- |
| 提交任务并保留任务 ID | 接收目标和文本资料 | 之后按原任务 ID 查询 |
| 查询进度、等待或回答澄清 | 汇报状态或请求补充信息 | 沿原任务继续处理 |
| 追加要求或发起关联追问 | 处理已保存的新要求 | 追问作为关联任务保留 |
| 读取结果、取消或恢复查询 | 写回任务结果与停止状态 | 可分别核对执行、读回和认可 |

<p align="center">
  <img src="docs/素材/星渡/task-workflow.svg" alt="委派文本任务、跟进进度和澄清、取回结果" width="760">
</p>

任务由委派进入进度跟进；Dot 提问时可沿原任务回答，最后按原任务 ID 取回结果。

还可以选择让 Dot 读取你指定的本机 Codex 对话历史，或请该对话处理一段文本并取回对应回合回复。这组本机对话能力默认关闭，需要在本机首次启用；启用后不必逐个登记对话。

## 开始使用

**准备：** Windows 10/11 x64、自己的 Codex 和 Dot，以及你自己的 OpenAI 账号、Secure MCP Tunnel、ChatGPT workspace 私有插件与 MCP Events 所需权限。Tunnel 需要专用 runtime key；Codex 订阅不会自动提供 Tunnel 权限。此项目不调用模型 API，也不提供免费的免登录 Tunnel。

1. 下载并运行上方的 Setup。它包含 Node 运行时，无需另装 Node 或 npm。安装程序未签名；Windows SmartScreen 或组织策略可能提示或阻止运行，SHA256 校验不能替代发布者签名。
2. 从开始菜单打开 **Codex Dots Bridge → 首次连接与维护**，按[首次连接指南](docs/首次连接.md)连接你自己的官方 Tunnel、私有插件和 Dot。需要时保持连接 `pending`，完成账号授权、保存 runtime key 并订阅后再继续。
3. 在新 Codex 对话中启用 Bridge 插件，调用 `dots_status` 查看实际连接状态。
4. 派一条无副作用文本任务，记录返回的 `task_id`；查询进度或回答澄清后，沿同一 ID 取回结果。

### Windows 托盘

<p align="center">
  <img src="docs/素材/星渡/tray-ready-demo.png" alt="Codex Dots Bridge alpha.21 托盘程序，以合成连接就绪状态渲染" width="420">
</p>

上图由 alpha.21 实际程序渲染，状态为合成演示；“连接就绪”不代表某条消息已成功。左键查看状态，右键切换登录 Windows 后自启；退出托盘后后台继续运行。

本源码候选增加[订阅自动检查与一键处理](docs/托盘订阅检查.md)：显示有效期，临期仅黄色提示，确认失效时本机提醒一次；点击后重新核验，必要时打开已保存的原规则。它不会自动重发任务或把打开页面当作续订成功。

第一次可以对 Codex 说：

> 把下面这段文字交给我的 Dot，整理成三条要点。提交后告诉我任务 ID。

然后查询原任务并取回结果。Tunnel ready、事件订阅 accepted 或任务入队本身都不等于 Dot 已经完成并返回结果。

## 可选：连接本机 Codex 对话

本机对话读取与发送是独立的可选能力，默认 `off`。首次启用 `read` 或 `read-send` 后无需逐对话登记；操作仍需由你明确指定对话和内容。

<p align="center">
  <img src="docs/素材/星渡/conversation-handoff-alpha21.svg" alt="读取官方本机 App Server 已保存的对话历史，或实验性发送并取回关联的新回合回复" width="760">
</p>

读取通过官方本机 App Server 分页获取已保存历史；发送能力仍属实验，仅关联指定对话返回的新回合回复。

- **读取示例：**“读取这条 Codex 对话链接里的持久历史，总结已确认的要求。”
- **发送示例：**“请把 `17 × 19` 发给这条 Codex 对话，并取回它本次回合的回复。”

历史分页取回不保证原始模型上下文完整，也不包含无法从已保存记录恢复的压缩前内容。已有发送在途时，新请求在落库前被拒绝；取得准确忙碌回合和 owner 后才提供下一回合选项，当前回合追加不支持。确认发送后，快速等待未取得回复会按原请求最多后台只读取回 24 小时；证据不足时保持未知，不补发。后台取回不会向其他聊天自动发送消息。

## 当前状态与实验边界

本候选在隔离临时数据库上验证逻辑、迁移和合成性能；Windows 成品、跨版本安装、每条真实链路至少 30 次往返和 72 小时稳定性仍待独立验收。简单聊天只保证一条文本的可靠往返，不承诺原生会话上下文连续。领取延迟只展示观察结果，不把事件接收当作任务完成。历史版本证据保留在[变更日志](CHANGELOG.md)，不能替代本候选验收。

当前按单用户、单台 Windows 电脑和一个现有 Dot 设计，并发默认 1。alpha 版本面向愿意按文档配置和反馈的试用者，不承诺适用于所有账号、设备策略或长时间无人值守场景。

## 文档

- [快速开始](docs/快速开始.md) · [首次连接与 Tunnel 配置](docs/首次连接.md)
- [任务与工具契约](docs/任务与工具契约.md) · [Dot 执行说明](docs/Dot执行说明.md)
- [维护与故障排查](docs/维护与故障排查.md) · [兼容性与已知限制](docs/兼容性与已知限制.md)
- [发布与升级](docs/发布与升级.md) · [alpha.21 安装与恢复验收](docs/alpha21启动恢复验收.md) · [安全说明](SECURITY.md)

## 从源码构建

维护者可在 Windows PowerShell 中运行：

```powershell
.\scripts\bootstrap.ps1
.\scripts\dev.ps1 install
.\scripts\dev.ps1 build
.\scripts\dev.ps1 test
.\scripts\package.ps1 -IncludeTunnel
```

构建需要 Node/npm 及官方 Tunnel 下载源访问。构建与本地测试不会发布 GitHub Release。贡献方式见[贡献指南](CONTRIBUTING.md)，依赖许可见[第三方许可说明](THIRD_PARTY_NOTICES.md)。

---

本项目采用 [MIT License](LICENSE)。

## Codex 云端开发环境

云端环境连接本仓库，用于源码开发、类型检查和构建。使用 Node 24，执行 `npm ci`、`npm run typecheck` 和 `npm run build`。Linux 环境不能替代 Windows 安装器、托盘、桌面 IPC、登录自启和真实 Dot 通道验收；不要在云端运行安装器或连接生产数据目录。个人运行密钥、数据库及本机配置不随源码上传。

仓库推送与 Codex 云端环境发布是两个步骤。更新已有环境时检查实际仓库版本、安装依赖并验证，再重新发布环境；已有云端任务保留各自状态，不能据此宣布其自动切换到新版本。
