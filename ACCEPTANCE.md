# 0.3.0-alpha.1：候选验收与迁移 / Candidate acceptance and migration

记录日期：2026-10-26。基线为 `0.2.0-alpha.32 / 126f09e`。这是候选构建时的验收记录，尚未生产部署；最终发布状态以对应 Release 及其附带验收报告为准。Windows CI、本机隔离安装、真实 Dot 和 72 小时运行分别记录，不能互相替代。历史版本证据见 [CHANGELOG.md](CHANGELOG.md)。

## 候选证据边界

诊断基线 `949cae1` 的 Windows CI `40208035010` 已通过：553 项 Node 用例中 552 通过、0 失败、1 项条件跳过；40 项发布检查及打包、托盘 HTTP/刷新、隔离 Setup 新装/重装/卸载通过。其 artifact 为 `12605201645`，安装回执为 `upgraded=false`，不证明跨版本升级。

本轮在该基线上补充 compact 检查点、continuation 索引及共享进度投影，新增长任务和续读测量。旧提交的测试或安装成功不能替代这些变更后的成品核对。源码、Windows ZIP、Setup、CI 与验收报告须按最终提交和摘要绑定；冻结成品后的追加进度保存在独立验收报告中，不为写入进度而重打包同版本。

Windows 本机历史失败包含旧 alpha.32 Setup 的 `exit 20 / tray_background_launch_unconfirmed` 和缺少实际子进程会话的 `verify_session` 失败，不能合并归因。后续隔离测试已取得路径句柄与 WMI 可见性证据，并在物理路径完成受支持启动、退出和 Setup 测试；这些结果只覆盖对应提交、成品与场景，不能追溯补齐旧失败的缺失字段，也不能替代最终成品的跨版升级与完整 H 验收。详细进度保存在按成品绑定的验收报告中。

后续本机候选新装曾返回 0，但状态保存为 `pending_tray_diagnostics`：创建返回 0、已观察到同会话进程，首次 `GetOwnerSid` 抛出 CIM 异常；稍后只读核对同一进程的路径、参数、创建时间、会话和 SID 均匹配，正常退出也成功。底层 CIM 异常原因仍未知，不能仅凭整个 helper 耗时判定超时。针对首次查询即放弃确认的路径，候选增加至多一次只读复核，绑定同一进程身份，保留原 RPC 超时、准确 SID 检查及一次 Create；反复异常、身份变化或明确错 SID 仍保持未知。此修复的对应 Windows 回归、新成品安装与跨版验收尚待完成，不借用之前成品的通过结果。

截至最近可核查的本机记录，72 小时和本机 30 次批次均未启动；真实验收将受控复用原 Tunnel/插件，候选绑定、目录和参数实际采用仍待验证。H 门禁未完成，不能安装生产、合并或发布。过去批次的详细记录作为历史证据保留；最终结论必须逐项核对本批原始结果，不能用摘要或自动检查的 passed 字样代替。

较大历史备份的离线 CPU 剖析发现，迁移后的全库摘要计算是已测得的主要耗时。SQLite BLOB 经整行 JSON 的 BigInt replacer 时会逐字节调用回调；候选改为按列编码，保持原摘要字节与所有完整性、备份及回退检查。回归须核对旧格式摘要、64 位整数、Unicode、空值、BLOB 和内容篡改拒绝；实际 Windows 耗时和新包仍须复测，不将原版剖析或合成编码探针视为新成品通过。

## 实施边界

保留 Node、SQLite、Windows 原生外壳、单 Dot 执行槽、任务身份、原回执、租约、修订和取消确认。简单聊天限定为一条文本的可靠往返，澄清作为该条最终文本返回；不承诺原生会话上下文连续。

| 工作包 | 当前源码提供的能力 | 验证边界 |
| --- | --- | --- |
| A：基线与备份 | 合成 SQLite 基准、请求预算案例；备份包含本机对话、固定 echo、owner notification 配置及迁移元数据 | 仅用临时 fixture，未读取或迁移个人数据库 |
| B：接纳与状态 | 同目标发送在途时落库前拒绝；准确 busy turn/owner 才能提供 next_turn；聊天拒绝 request_input；终态通知过滤；预算与错误分类 | 隔离状态与协议回归，不代表平台会领取 |
| C：领取与迟到回复 | 队首/执行槽感知的领取延迟；ACK 后准确回合只读取回，持久化日志身份、偏移和 24 小时截止；重启恢复完整证据 | 不重发、不生成新业务；真实迟到回复及重启需真机复验 |
| D：迁移门禁 | 一致性备份、停止归属保护、维护配置、事务迁移和显式激活；不兼容旧配置被拒绝 | 隔离 fixture 验证门禁；da6feb0 的 alpha.32 真实升级和自动托盘通过一轮，alpha.30 路径仍待单独核对 |
| E：存储与等待 | 可索引状态/到期字段；schema 2 正文拆分与冻结父上下文引用；compact 回执；持久变更序号和提交后唤醒；诊断分层轮转 | full 兼容路径保留快照成本；需要分别报告两种模式 |
| F：读取预算与分页 | 完整历史与上下文共用 2 活动/16 排队；schema 2 不可变分页正文和独立交付进度；保留 UTF-16、哈希、绑定及 CAS/epoch | 单源 60 秒、单快照 32 MiB；128 MiB 缓存上限不等于 RSS 上限 |
| G：呈现与文档 | 鉴权轻量托盘接口、实例/版本/时间校验；工具目录声明 compact 和明确状态原因 | 隐藏托盘零新增 Node 状态进程、真实客户端采用新版目录待验证 |
| H：统一验收 | 可重复本地检查和以下待验收清单 | 尚未完成，不能宣称全能力稳定 |

业务历史及已完成快照不自动删除。新运行诊断按 30 天或 256 MiB 逻辑数据上限轮转，历史混合证据保留，业务游标高水位单独持久化。背景结果仅由原 caller 查询或既有授权通知路径呈现。

## 接口兼容

- 命令默认 `response_mode: full`；新调用端明确传 `compact`。首次接纳时绑定模式，同一操作键改模式重试返回冲突；旧记录返回原回执。
- compact 返回操作/任务身份、状态、修订、变更序号及必要引用；正文仍通过原查询取回。领取可返回当前工作输入及执行规则。
- 业务参数序列化 UTF-8 上限为 1 MiB，HTTP/MCP 信封为 2 MiB。100,000 个中文字符的独立文本应通过，字段组合仍受总预算约束；超限、无效参数、状态冲突、暂时不可用分别分类。
- 任务完成、事件接收、发送 ACK 和准确回复是不同证据。领取延迟在 60 秒和 5 分钟展示不同原因，不自动改变任务终态。
- `dots_status(summary:true)` 和托盘使用聚合摘要；缺省保留旧版全任务元数据索引，其响应体和序列化仍随历史增长。下方状态基准测摘要路径，不能等同缺省 MCP 端点。
- 旧接口至少保留一个后续发布周期，撤销旧写接口前必须验证真实客户端迁移。工具出现在源码中不代表宿主已发现并采用。

## 离线迁移步骤

以下命令由维护者在核对实例归属和备份路径后执行；本次源码实现未执行实际安装或迁移。示例使用已构建的候选 CLI，路径需替换为目标实例和一个空的受保护备份目录。

```powershell
node dist/main.js run --stop --data-dir "$env:LOCALAPPDATA\CodexDotsBridge"
node dist/main.js migration-preflight --data-dir "$env:LOCALAPPDATA\CodexDotsBridge"
node dist/main.js migrate-storage --to "D:\BridgeBackups\before-schema2" --data-dir "$env:LOCALAPPDATA\CodexDotsBridge"
```

活动任务、发送、读取或未解决执行会阻止迁移；不能通过删除锁或修改状态绕过。迁移持有实例归属，创建并校验 SQLite 一致性备份，写入 schema 2 维护配置后在事务中迁移，返回 `migration_id`。此时业务入口仍关闭；核对安装提交、离线任务和旧回执读取后再激活：

```powershell
node dist/main.js activate-storage --migration-id "返回的 migration_id" --data-dir "$env:LOCALAPPDATA\CodexDotsBridge"
node dist/main.js run --start --data-dir "$env:LOCALAPPDATA\CodexDotsBridge"
```

数据库版本和配置门禁必须一起保留。alpha.32 严格校验 schema 1 配置，借此拒绝进入 schema 2 业务库；不要手工降级配置字段。

- 事务未提交：回滚事务，恢复本次维护门禁。
- 已迁移但未开放业务：确认无新业务写入后才允许恢复完整预迁移快照；先恢复到空目录并校验，不直接覆盖数据库。
- 候选 CLI 的 `rollback-storage --migration-id ID` 只允许未激活且摘要证明没有新写入的数据库回退；备份变化或已激活时拒绝。
- 已开放业务：只允许支持当前数据库版本的程序或向前修复，不自动用旧快照覆盖新结果。
- 卸载保留数据；恢复备份不自动发送任务、消息或通知。真实 Windows 安装提交和门禁联动仍须独立验收。

安装器若返回恢复状态码 `21`，表示已进入可能激活的提交边界：保留兼容的新程序和 `.setup-activation.json`，不得恢复旧数据库或删除标记来绕过保护。停止后台并核对当前安装目录后，可执行该目录的 `setup-lifecycle.ps1 -Action RecoverActivation -InstallDirectory <安装目录>`；它重新核对程序、注册和迁移身份，完成激活后保持后台停止，再由维护者明确启动。中断的未激活迁移则由原 `migration_id` 的 `rollback-storage` 核对持久日志和摘要后恢复。

## 可重复的本地验证

使用 Node 24，在仓库根目录执行：

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run --silent benchmark > benchmark.jsonl
```

实际主进程提供 caller 鉴权的 `POST /control/resources`（请求体 `{}`），返回实例、版本、进程、观察时间及等待者、完整历史/上下文活动读取与排队、回复观察定时器和缓存计数。采样只读内存计数，不查询业务历史、推进游标或触发外部检查。`available=false` 明确表示组件未加载；缓存字节估算已保留的 UTF-16 字符串，不包含 SQLite、活动源读取或 App Server 的全部内存。收尾在请求均已取回且主进程仍运行时核对零活动计数，再正常停止。

快速检查及单独测量存储版本：

```sh
npm run benchmark -- --sizes 1000 --samples 20 --messages 100 --waiters 1,10,50
npm run benchmark -- --storage 2 --sizes 1000,10000,100000 --samples 100 --messages 100,1000 --waiters 1,10,50
```

基准只创建临时数据库，不访问个人任务、凭据或网络。JSONL 记录版本、Git HEAD、工作区改动标记、源码摘要、CPU/Node/平台、预热后的 p50/p95/p99、查询计划、SQLite 文件/逻辑大小和 RSS。默认分别测 schema 1/2、full/compact；其中 schema 1 是当前候选的兼容路径，不是未经修改 alpha.32 的性能。

历史规模为 1,000/10,000/100,000 条，始终一条活动任务，历史输入 1,024 字符、结果 4,096 字符。`single_task_observation` 测同一活动任务的 `observe(mode=task)` 摘要投影，`status_summary` 测全部任务的状态聚合，两者分别报告；“20%＋1ms”的历史放大门槛用于单任务摘要。预热 20 次，默认采样 100 次；100/1,000 次追加分别新建数据库。等待者为 1/10/50，统计空闲 250ms 内 SELECT 数和完成后残留。RSS 含同一进程先前场景和 SQLite 原生内存，不能直接作为稳态服务占用，需 Windows 分场景长期采样。

合成基准不包含网络或模型执行。Windows p95 ≤100ms、历史放大不超过 20%＋1ms、资源上限和 72 小时稳定性仍是验收目标；Linux 结果不能替代。

### 2026-10-25 合成测量记录

Linux x64、Node 24.19.0、AMD EPYC 9V74 80-Core Processor（环境提供 5 个逻辑 CPU），schema 2。工作区基于 `126f09e`，有未提交改动；测量开始于 `2026-10-25T06:40:29.611Z`，源码摘要为 `5db6a7cbe8410d12e6a8f7830a63d877723c62549f76addc5fab408ddb9dbede`。下表是该快照的观测值，不是 alpha.32 对比收益或 Windows 验收。

| 指标 | 1,000 条历史 | 10,000 条历史 | 100,000 条历史 |
| --- | ---: | ---: | ---: |
| 单个活动任务 get p95 | 0.084 ms | 0.065 ms | 0.058 ms |
| 状态聚合 p95 | 0.121 ms | 0.656 ms | 5.308 ms |
| 最近 10 条摘要 p95 | 0.111 ms | 0.093 ms | 0.131 ms |
| 当时进程 RSS | 83.9 MB | 93.2 MB | 96.1 MB |

单任务使用主键查找，到期查询使用 `tasks_due` 索引；统计扫描状态索引，仍随总记录数增长。等待者 1/10/50 的空闲 250ms SELECT 数均为 0，唤醒后等待者组均为 0。

| 追加测量 | 100 次 | 1,000 次 |
| --- | ---: | ---: |
| compact 回执 JSON 字节 | 24,327 | 243,031 |
| full 回执 JSON 字节 | 5,776,978 | 560,320,535 |
| compact SQLite 逻辑字节 | 516,096 | 3,137,536 |
| compact 总耗时 | 28.296 ms | 312.330 ms |

本测量只覆盖没有回答澄清的普通文本追加；schema 2 compact 路径使用元数据更新和新增记录，避免重建整份任务。其他命令和 full 兼容路径仍有历史读取/序列化成本，不能据本样本宣称所有操作达到线性复杂度。RSS 不包含独立 Windows、App Server 或模型运行验证。

完整历史分页用 UTF-16LE BLOB 支持按既有偏移精确读取；纯 ASCII 正文字节数可能是 UTF-8 的两倍。这里不宣称所有类型历史都缩小数据库。

本轮接口及迁移调整后重新执行 Linux 全量回归，共 549 项：498 通过、0 失败、51 项按平台或既有条件跳过。TypeScript 构建及公开源码与 Git 历史检查通过（447 个历史 blob）。这些检查不包括 C#、PowerShell、Inno 真机执行。

Windows CI 已接入打包后的托盘 HTTP 和刷新生命周期测试。候选 PR 和 CI 产物不等同于完成本机部署或正式发布。

首轮 Windows CI（提交 `30fd453`，run `40172871552`）执行 549 项：545 通过、3 失败、1 跳过，因此未进入打包和安装器阶段。失败集中在本机自动加载后的发送与等待。后续修正包括文件身份的精确整数保存（NTFS 文件 ID 可能超出 JavaScript 安全整数范围）和截止时间前提前唤醒的重试边界；修正后的 Windows 结果须单独核对，不能将 Linux 通过视为这些失败已关闭。

第二轮 Windows CI（提交 `d720a83`，run `40174051334`）的 Node 用例为 551 项：550 通过、0 失败、1 跳过，上述 3 项已复验通过。随后 PowerShell 5 安装回退 fixture 发现旧事务无迁移时仍访问不需要的激活标记目录；修正为仅有迁移 ID 时检查该目录。安装相关后续步骤仍须重跑，整条 CI 尚未通过。

后续 `c901575`（run `40174718143`）及 `1d40f1f`（run `40176685903`）整条 Windows CI 通过：551 项 Node 用例中 550 通过、0 失败、1 跳过，PowerShell 保护、打包、托盘 HTTP/刷新和隔离 Setup 新装/重装/卸载通过。两次安装回执均为 `upgraded=false`、`fromVersion=null`，不能证明跨版升级。`1d40f1f` 只为刷新 fixture 加入回执同步，确保测试在旧回执交给 UI 前变更 generation；生产代码与 `c901575` 相同。

独立 Windows 本机使用已校验摘要的 `c901575` CI 成品：HTTP 60 项断言和刷新全部 11 项检查通过；原旧 EXE 配原 fixture 再次出现 `create-generation` 超时，加日志诊断未捕获原因，仍未闭环。alpha.30 旧基线安装返回 `tray_background_launch_unconfirmed`，未进入候选升级；alpha.32 候选 Prepare 返回 `task_state_unavailable`，没有提交升级。代表性对照确认 Windows PowerShell 5.1 向 `node -e` 传递旧库检查脚本时丢失 SQL 字符串的双引号，同一脚本以文件执行可读取数据库且活动计数为零。候选修正为从标准输入读取脚本，并增加执行真实 PS5/Node/SQLite 的回归，覆盖历史 uncertain、各类活动工作和坏库拒绝；修正后的 Windows CI 与真实升级仍须重新验证。

上述失败后身份、凭据、任务/结果、历史 uncertain 和读取快照均保留。独立成品迁移/回退 fixture 验证了维护拒绝业务、开放前无写入可回退、新写入及开放后拒绝旧库恢复；这不能替代 Setup 跨版安装通过。生产仍未升级，正式 Release 未发布。

后续本机对照中，`1d40f1f` 同步 fixture 配新旧两个 EXE 均通过。独立 Windows 小例子固定复现了日志读写的共享冲突：`File.ReadAllLines` 的 `FileShare.Read` 会排斥子进程 `AppendAllText`，返回 `0x80070020`；实际读取也会与已打开的写入者冲突。fixture 改为允许共享写入的只读流，并增加写入句柄持有期间读取日志的断言，不放宽等待或重试。这个缺陷的复现不能追溯证明原超时的唯一原因，修正后的完整验证仍单独记录。

后续 `c00c367`（run `40178512318`）Windows CI 全绿：553 项 Node 用例中 552 通过、0 失败、1 跳过；托盘 HTTP 60 项断言及刷新 12 项检查通过。本机校验同一 CI 成品后，alpha.32 → 候选的实际 Setup 升级和卸载均退出 0，身份、凭据、历史请求和固定快照保留，维护与回退门槛通过；但是安装状态出现 `pending_tray_diagnostics`，自动拉起托盘仍未通过。一次独立原逻辑托盘启动成功且正常退出，未复现安装上下文故障，不能关闭该问题。旧 alpha.30 基线失败也未关闭。

本次补充只保存托盘失败阶段、PID、CIM 返回码及异常类型/HResult，不记录命令、环境、正文或原始异常文本；Setup 验收增加安装后直接 `--running` 检查，不允许以手动启动补齐。此变更用于补足证据和验收缺口，尚不是原安装失败的根因修复。生产安装和正式发布继续阻塞。

## 仍须完成的真实验收

1. 固定 Windows 基准机记录硬件、Node、最终提交和数据集；重复上述规模，测静置/隐藏托盘/展开窗口/任务执行的 CPU、RSS、句柄和进程创建次数。隐藏托盘周期查询新增 Node 进程应为零。
2. 从 alpha.32 成品真实跨版本升级：在途拒绝、迁移中断、维护模式不投递、安装提交前回退、开放后拒绝不兼容降级、卸载保留。不能用同版本重装替代。
3. 正向任务、本机发送各至少 30 次正常往返；聊天至少 30 条顺序消息，逐项核对 request_id、ACK、准确回合与回复。超时、阻塞、未知不计成功。
4. 完整历史与上下文分别验证短/长历史、读取期间源变化、重启和缓存淘汰；两个最大允许读取的进程和内存预算受控。少读内容不能算性能改善。
5. Events HTTP 200 后零领取单独跟踪根因和样本，观察字段不是修复结论。真实新版目录发现、compact 参数采用、可选 echo 及已授权 owner notification 场景也须核对。
6. 72 小时 Windows 稳定性：预热后等待者、句柄和子进程不持续单调增长；观察结束后活动观察器归零。自然重启、失联、日志身份改变、ACK 丢失须验证不重发。

## English

0.3.0-alpha.1 is an unreleased source candidate based on alpha.32. Isolated fixtures and synthetic SQLite measurements cover only exercised code paths. They do not prove Windows artifacts, live round trips, client catalog adoption, native recovery or 72-hour stability. HTTP 200 events without pickup remain a separate unresolved blocker.

Schema 2 migration requires a stopped, idle instance, consistent backup, maintenance gating, transactional verification and activation after installation commits. Do not run alpha.32 against an upgraded database or restore old snapshots over new business writes. Measure full and compact separately. Historical release evidence is in the changelog.
