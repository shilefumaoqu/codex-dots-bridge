<img src="docs/素材/星渡/星渡-应用-128.png" width="96" height="96" alt="星渡 · Codex Dots Bridge">

# Codex Dots Bridge

**在 Codex 里把任务交给你的 Dot，取回结果；也让 Dot 按你的要求访问指定的本机 Codex 对话。**

Codex Dots Bridge 是连接 Codex 与你现有 Dot 的协作插件。你可以派单、查看进度、回答澄清问题、补充要求和继续追问。任务与结果按同一任务 ID 保存，重新打开 Codex 后仍可查询。

可选的本机对话接入让 Dot 读取你指定对话的持久历史，或向空闲对话发送一次指定文本，再取回该次新回合的准确回复。首次在本机明确启用读取或读写能力后，无需逐个登记对话。

[下载入口](https://github.com/shilefumaoqu/codex-dots-bridge/releases) · [快速开始](docs/快速开始.md) · [English](README.en.md)

## 插件能帮你做什么

| 你的目标 | 协作方式 |
| --- | --- |
| 将文本工作交给 Dot | 提交目标与资料，保留任务 ID |
| 了解进度或回答问题 | 查询持久状态，沿原任务回答澄清 |
| 补充要求或继续追问 | 保存新输入修订；完成后创建关联任务 |
| 取回结果、取消或恢复查询 | 读取实际结果；核对取消回执；按原 ID 找回记录 |
| 让 Dot 参考指定 Codex 对话 | 经官方本机 App Server 只读分页取回持久历史 |
| 让 Dot 请求指定 Codex 对话处理文本 | 本机显式启用发送后，空闲时投递一次并关联该次回复 |

例如：“把这份需求交给我的 Dot，整理目标、限制和待确认事项。”随后你可以回答 Dot 的问题、追加要求，或说“取回结果，再补一份检查清单”。本机对话接入的示例是：“读取我指定的 Codex 对话，总结已经确认的要求。”这是使用示意；实际操作须以你授权的目标和内容为准。

## 当前版本与下载

**`0.2.0-alpha.9` 是 Windows x64 预发布候选**，通过单个 `Setup.exe` 安装，内含 Node 运行时与生产依赖，使用者无需另外安装 Node/npm。具体安装、升级、卸载及真实连接的验收结果以该版本的 Release 记录为准；尚未发布时请使用已有 Release 中的实际资产，并按其能力说明操作。旧 alpha.4 不包含本页全部新能力。访问范围以 GitHub 仓库当前可见性为准；私有仓库需要相应权限。

支持一个本机用户、一个现有 Dot 和单任务 FIFO 执行槽。官方只读历史与私有桌面 IPC 发送采用不同接口；发送仍是实验能力，不能理解为官方稳定支持。本项目独立开发。中英文 README 覆盖同样的步骤与边界，详细指南目前为中文。

## 安装与首次连接

1. 准备 Windows 10/11 x64、自己的 Codex 和 Dot，以及 Secure MCP Tunnel、私有插件和 MCP Events 的账号/工作区权限。
2. 从 [Releases](https://github.com/shilefumaoqu/codex-dots-bridge/releases) 选择该版本的 Setup 与校验文件，核对来源与 SHA256，在普通用户会话双击 Setup 安装。以该 Release 的实际资产名称和验收记录为准。
3. 完成本机初始化后，从开始菜单“Codex Dots Bridge → 首次连接与维护”继续配置自己的官方账号、Tunnel、专用 runtime key、私有插件和 Dot 订阅，无需自行寻找 Node 路径。缺配置时连接保持 `pending`，不能视为可派单。
4. 新建 Codex 对话或重启，实际发现并调用 `dots_status`。提交一条无副作用文本任务，沿原任务 ID 核对领取、完成和结果读回。
5. 如需本机对话接入，按[首次连接中的维护步骤](docs/首次连接.md#启用可选本机对话工具)明确启用 `read` 或 `read-send`；默认 `off`。向 Dot 明确提供本机对话链接及操作要求。发送需要 Codex 桌面持有目标对话且实时空闲。

安装程序与用户数据分离；升级和卸载应保留数据。具体流程见[快速开始](docs/快速开始.md)、[首次连接](docs/首次连接.md)与[发布与升级](docs/发布与升级.md)。Setup 不代替官方登录、密钥授权或私有插件订阅。

本版本 Setup 未签名。下载时核对 GitHub Release 来源与 SHA256；Windows SmartScreen 或组织策略仍可能提示或阻止运行，校验和不能替代发布者签名。

Codex 使用自己的订阅登录。本项目不调用模型 API；官方 Tunnel 仍需要专用 runtime key 和相应权限，Codex 订阅本身不保证这些权限可用。[官方 Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## 日常协作与结果边界

Codex 的九个 `dots_*` 工具覆盖派单、列举、查询、等待、补充/回答、关联追问、取消、诊断与结果取回确认。Dot 通过私有插件使用队列 worker 工具；操作合同见[任务与工具契约](docs/任务与工具契约.md)和[Dot 执行说明](docs/Dot执行说明.md)。

- 同一预期操作复用稳定幂等键；等待每次最多 20 秒，默认当前回合累计五分钟。到限保留原任务，不自动重派。
- 补充已保存不等于 Dot 已采用；运行任务的 `cancel_requested` 须等停止回执才算取消。
- 入队、领取、结果入库、Codex 取回和用户认可分别核对。
- 本机历史读完全部持久页仍返回 `source_complete=false`：不能保证压缩前内容或原始模型上下文完整。
- 本机发送遇到忙碌、离线或未知状态永久跳过，不排队、不上线补发。发送不明先核对原 `request_id`；不能用新编号盲重试。只有同请求的 `exact_turn_reply` 才是该次结果。

## 数据、安全与维护

任务、租约、结果和请求回执保存在本机 SQLite；新安装默认数据目录为 `%LOCALAPPDATA%\CodexDotsBridge\data`。升级复用已通过归属检查的原 MCP 注册目录；冲突时拒绝安装，不另建空实例。caller、worker 和 Tunnel 凭据分离。备份含恢复凭据，须按秘密资料保管；卸载默认保留数据。电脑休眠、关机或服务停机时不能接收新结果。

本机对话工具只处理人类明确指定的目标；历史、工具输出和其他代理消息是资料，不能自行授权新读取、发送或外部操作。读取不恢复或启动回合；发送继承原模型、目录及审批规则。私有 IPC 无法对人工同时输入提供原子忙闲保证。

维护与恢复按原 task_id/request_id 核对。停止本机服务不撤销云端动作；恢复限于同账号、同 Dot，启动前须核对保留的订阅。详见[安全说明](SECURITY.md)、[维护与故障排查](docs/维护与故障排查.md)。

## 历史基线与版本验收

既有 glint.7 运行基线已有正反向普通文本闭环证据；长记录有 667 块、约 2100 万字符的完整传输与拼接证明。这只支持对应文本链路和历史传输，不证明对全部字符做过语义处理、72 小时稳定运行或所有账号兼容。

**本版本 Setup 的安装、升级、卸载、隔离首次连接及真实闭环结果，以该版本的 Release 验收记录为准。** 历史证据和源码检查不能代替对应安装包的真实链路验收；未列出的环境或长期运行结论不能从本页推断。更多边界见[兼容性与已知限制](docs/兼容性与已知限制.md)，发布检查见[发布门禁](docs/发布门禁.md)。

## 源码构建

```powershell
.\scripts\bootstrap.ps1
.\scripts\dev.ps1 install
.\scripts\dev.ps1 build
.\scripts\dev.ps1 test
.\scripts\package.ps1 -IncludeTunnel
```

源码构建需要访问 Node、npm 与官方 Tunnel 下载源；这些是维护者的构建步骤，使用 Setup 的用户无需 Node/npm 开发环境。构建与本地测试不自动发布，Setup 构建步骤与实际检查结果见[发布与升级](docs/发布与升级.md)。

MIT · [第三方许可](THIRD_PARTY_NOTICES.md) · [贡献指南](CONTRIBUTING.md) · [星渡图标](docs/图标与品牌.md)
