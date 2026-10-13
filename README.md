<p align="center">
  <img src="docs/素材/星渡/星渡-应用-128.png" width="88" alt="Codex Dots Bridge 图标">
</p>

<h1 align="center">Codex Dots Bridge</h1>

<p align="center">把任务交给你的 Dot，在 Codex 中跟进过程并取回结果。</p>

<p align="center">
  <a href="README.en.md">English</a> · <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/tag/v0.2.0-alpha.21">v0.2.0-alpha.21</a> · Windows x64 · <a href="LICENSE">MIT</a>
</p>

<p align="center">
  <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/download/v0.2.0-alpha.21/Codex-Dots-Bridge-0.2.0-alpha.21-Setup.exe"><strong>下载 Windows 安装程序</strong></a>
</p>

<p align="center">
  <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/tag/v0.2.0-alpha.21">Windows ZIP、SHA256 校验文件与完整发布说明</a>
</p>

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

还可以选择让 Dot 读取你指定的本机 Codex 对话历史，或请该对话处理一段文本并取回对应回合回复。这组本机对话能力默认关闭，需要在本机首次启用；启用后不必逐个登记对话。

## 开始使用

**准备：** Windows 10/11 x64、自己的 Codex 和 Dot，以及你自己的 OpenAI 账号、Secure MCP Tunnel、ChatGPT workspace 私有插件与 MCP Events 所需权限。Tunnel 需要专用 runtime key；Codex 订阅不会自动提供 Tunnel 权限。此项目不调用模型 API，也不提供免费的免登录 Tunnel。

1. 下载并运行上方的 Setup。它包含 Node 运行时，无需另装 Node 或 npm。安装程序未签名；Windows SmartScreen 或组织策略可能提示或阻止运行，SHA256 校验不能替代发布者签名。
2. 从开始菜单打开 **Codex Dots Bridge → 首次连接与维护**，按[首次连接指南](docs/首次连接.md)连接你自己的官方 Tunnel、私有插件和 Dot。需要时保持连接 `pending`，完成账号授权、保存 runtime key 并订阅后再继续。
3. 在新 Codex 对话中启用 Bridge 插件，调用 `dots_status` 查看实际连接状态。
4. 派一条无副作用文本任务，记录返回的 `task_id`；查询进度或回答澄清后，沿同一 ID 取回结果。

第一次可以对 Codex 说：

> 把下面这段文字交给我的 Dot，整理成三条要点。提交后告诉我任务 ID。

然后查询原任务并取回结果。Tunnel ready、事件订阅 accepted 或任务入队本身都不等于 Dot 已经完成并返回结果。

## 可选：连接本机 Codex 对话

本机对话读取与发送是独立的可选能力，默认 `off`。首次启用 `read` 或 `read-send` 后无需逐对话登记；操作仍需由你明确指定对话和内容。

- **读取示例：**“读取这条 Codex 对话链接里的持久历史，总结已确认的要求。”
- **发送示例：**“请把 `17 × 19` 发给这条 Codex 对话，并取回它本次回合的回复。”

历史分页取回不保证原始模型上下文完整，也不包含无法从已保存记录恢复的压缩前内容。发送遇到忙碌时，Bridge 会说明状态并由你选择是否等待下一回合；当前回合追加不支持。离线、未知或等待条件失效时不会自动补发。

## 当前状态与实验边界

alpha.21 的 Windows 安装、升级与恢复检查已有验收；正向合成任务完成并取回，一条用户发起的本机对话发送往返也取得真实回复。自动 Events 及时领取、忙碌/离线等异常分支、真实重启恢复及长期运行仍未完整验收。曾出现的宿主工具目录拒绝尚无根因结论；后续成功样本不代表问题已解决。

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
