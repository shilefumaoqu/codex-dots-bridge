<p align="center">
  <img src="docs/素材/星渡/星渡-应用-128.png" width="88" alt="Codex Dots Bridge 图标">
</p>

<h1 align="center">Codex Dots Bridge</h1>

<p align="center">把任务交给你的 Dot，在 Codex 中跟进过程并取回结果。</p>

<p align="center">
  <a href="README.en.md">English</a> · <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/tag/v0.2.0-alpha.31">v0.2.0-alpha.31</a> · Windows x64 · <a href="LICENSE">MIT</a>
</p>

<p align="center">
  <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/download/v0.2.0-alpha.31/Codex-Dots-Bridge-0.2.0-alpha.31-Setup.exe"><strong>下载 Windows 安装程序</strong></a>
</p>

<p align="center">
  <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/tag/v0.2.0-alpha.31">Windows ZIP、SHA256 校验文件与完整发布说明</a>
</p>

> **当前发布：0.2.0-alpha.31（实验性预发布）**。新增 Windows 连接拒绝恢复、准确健康状态和接单工具结果诊断，保留已有托盘、完整历史与增量接续功能。配套 Tunnel 为本地修补版，并非官方原版。ChatGPT→Dot 连续聊天仍未通过，原自然 Events 后续也有零领取样本；请先阅读 [本版验收与限制](ACCEPTANCE.md)。程序就绪不等于消息往返成功。

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

历史分页取回不保证原始模型上下文完整，也不包含无法从已保存记录恢复的压缩前内容。发送遇到忙碌时，Bridge 会说明状态并由你选择是否等待下一回合；当前回合追加不支持。离线、未知或等待条件失效时不会自动补发。

## 当前状态与实验边界

alpha.30 的启动辅助环境和回执修复已有定向测试、专门审查、成品及本机升级记录。alpha.21 的 Windows 安装、升级与恢复检查为历史验收；正向合成任务完成并取回，一条用户发起的本机对话发送往返也取得真实回复。自动 Events 及时领取、忙碌/离线等异常分支、真实重启恢复及长期运行仍未完整验收。曾出现的宿主工具目录拒绝尚无根因结论；后续成功样本不代表问题已解决。

[alpha.21 历史 Windows CI 结果](https://github.com/shilefumaoqu/codex-dots-bridge/actions/runs/38419703662)：38 项中 35 项通过，3 项历史 Git 测试失败；相同源码在本机 38/38 通过，环境差异原因未确认，后续 CI 构建步骤已跳过。另有 149 份源码与 286 个历史 Git blob 的公开内容隐私扫描未发现问题；该扫描结果不代表 CI 全部通过。

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