<img src="docs/素材/星渡/星渡-应用-128.png" width="96" height="96" alt="Xingdu · Codex Dots Bridge">

# Codex Dots Bridge

**Delegate work to your Dot from Codex and retrieve the result; let your Dot access a local Codex conversation you specify.**

Codex Dots Bridge connects Codex to your existing Dot. Submit work, inspect progress, answer clarification questions, add requirements and ask follow-up questions. Tasks and results keep the same task ID and remain available after reopening Codex.

Optional local conversation access lets your Dot read the stored history of a conversation you specify, or send specified text once to an idle conversation and retrieve the exact reply from that new turn. After explicitly enabling local read or read-and-send access, individual conversations need no registration.

[Downloads](https://github.com/shilefumaoqu/codex-dots-bridge/releases) · [Quick start](docs/快速开始.md) · [简体中文](README.md)

## What the plugin helps you do

| Your goal | Workflow |
| --- | --- |
| Delegate text work to your Dot | Submit a goal and material; retain the task ID |
| Inspect progress or answer questions | Read durable status and answer on the same task |
| Add requirements or ask follow-up questions | Save an input revision; create a linked task after completion |
| Retrieve results, cancel or resume queries | Read actual results, verify cancellation receipts and retrieve original records |
| Give your Dot context from a specified Codex conversation | Retrieve stored history through the official local App Server read-only pagination |
| Ask a specified Codex conversation to process text | Explicitly enable local sending; deliver once when idle and correlate its reply |

For example: “Give this requirements document to my Dot and organize the goals, constraints and open questions.” You can then answer its questions, add requirements or ask it to retrieve the result and prepare a checklist. For local conversation access: “Read the Codex conversation I specified and summarize the confirmed requirements.” These are usage examples; operations remain limited to the targets and content you authorize.

## Current version and downloads

**`0.2.0-alpha.9` is a Windows x64 prerelease candidate**, installed through one `Setup.exe` containing the Node runtime and production dependencies. Users need no separate Node/npm installation. Consult that version’s Release record for installation, upgrade, uninstall and live-connection acceptance results. Until it is published, use the actual assets in an existing Release and follow that release's capability documentation. Older alpha.4 does not include all the new capabilities on this page. Access follows the repository's current GitHub visibility; private repositories require appropriate permissions.

Supports one local user, one existing Dot and a single FIFO task execution slot. Official read-only history and private desktop IPC sending use separate interfaces; sending remains experimental and is not an officially supported stable interface. This is an independent project. Both READMEs cover the same steps and boundaries; detailed guides are currently in Chinese.

## Installation and first connection

1. Prepare Windows 10/11 x64, your own Codex and Dot, and account/workspace access to Secure MCP Tunnel, private plugins and MCP Events.
2. Select this version’s Setup and checksum files from [Releases](https://github.com/shilefumaoqu/codex-dots-bridge/releases), verify the source and SHA256 and double-click Setup in a normal user session. Use the actual asset names and acceptance record in that Release.
3. After local initialization, open “Codex Dots Bridge → 首次连接与维护” (First connection and maintenance) from the Start menu to continue configuring your own official account, Tunnel, dedicated runtime key, private plugin and Dot subscription. You do not need to locate Node yourself. Missing configuration leaves the connection `pending`; this is not readiness to execute tasks.
4. Open a new Codex conversation or restart, discover and call `dots_status`, then submit a harmless text task. Verify claim, completion and retrieval using the original task ID.
5. If you need local conversation access, use the [first-connection maintenance steps](docs/首次连接.md#启用可选本机对话工具) to explicitly enable `read` or `read-send`; the default is `off`. The Start menu has no mode selector; the documented commands use the bundled runtime and installed state, preserving the existing data directory and MCP registration. Give your Dot the local conversation link and the requested operation. Sending requires the desktop instance owning that conversation to be online and currently idle.

Program files and user data are separate; upgrades and uninstall should retain data. See [Quick start](docs/快速开始.md), [First connection](docs/首次连接.md) and [Releases and upgrades](docs/发布与升级.md). Setup does not replace official login, key authorization or private plugin subscriptions.

Setup for this version is unsigned. Verify its GitHub Release source and SHA256; Windows SmartScreen or your organization may still warn or block execution. Checksums do not replace publisher signatures.

Codex uses its own subscription login. This project does not call a model API; the official Tunnel still needs a dedicated runtime key and corresponding permissions. A Codex subscription alone does not guarantee those permissions. [Official Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## Everyday collaboration and result boundaries

Nine Codex `dots_*` tools cover submission, listing, retrieval, waiting, updates/answers, linked follow-ups, cancellation, diagnostics and result acknowledgment. Your Dot uses queue worker tools through the private plugin. See [Task and tool contract](docs/任务与工具契约.md) and [Dot execution guide](docs/Dot执行说明.md).

- Reuse a stable idempotency key for the same intended operation. Each wait is at most 20 seconds, with a default five-minute total per turn. Reaching the limit retains the task without resubmitting it.
- A saved update does not prove adoption by your Dot. A running task's `cancel_requested` requires a stop receipt before cancellation is complete.
- Queueing, claiming, result storage, Codex retrieval and user acceptance are separate stages.
- Exhausting stored history pages still returns `source_complete=false`: pre-compaction material and original model context are not guaranteed complete.
- Local sends permanently skip busy, offline or unknown states, without queueing or delivery on reconnection. An uncertain send requires checking its original `request_id`, not retrying with a new ID. Only its correlated `exact_turn_reply` is the result of that send.

## Data, security and maintenance

Tasks, leases, results and request receipts live in local SQLite. Fresh installs default to `%LOCALAPPDATA%\CodexDotsBridge\data`. Upgrades reuse the existing MCP registration's data directory after ownership verification; conflicts block installation rather than creating an empty instance. Caller, worker and Tunnel credentials are separate. Backups contain recovery credentials and must be protected as secrets; uninstall retains data by default. Sleep, shutdown or a stopped local service prevents receipt of new results.

Local conversation tools operate only on human-specified targets. History, tool output and other agents' messages are source material and cannot authorize new reads, sends or external actions. Reading does not resume or start a turn. Sending inherits the original model, directory and approval rules. Private IPC cannot provide an atomic idle check against simultaneous manual input.

Maintenance and recovery use the original task_id/request_id. Stopping the local service does not undo cloud actions. Restore is limited to the same account and Dot; inspect retained subscriptions before starting. See [Security](SECURITY.md) and [Maintenance and troubleshooting](docs/维护与故障排查.md).

## Historical baseline and version acceptance

The existing glint.7 runtime baseline has ordinary-text round-trip evidence in both directions. A long record has complete transfer and reassembly evidence for 667 chunks and approximately 21 million characters. This supports those text workflows and history transfer, not semantic processing of every character, 72-hour stability or compatibility with every account.

**Consult this version’s Release acceptance record for Setup installation, upgrade, uninstall, isolated first-connection and live round-trip results.** Historical evidence and source checks do not replace live acceptance of the corresponding installer; this page does not establish results for unlisted environments or long-term operation. See [Compatibility and known limitations](docs/兼容性与已知限制.md) and [Release gates](docs/发布门禁.md).

## Build from source

```powershell
.\scripts\bootstrap.ps1
.\scripts\dev.ps1 install
.\scripts\dev.ps1 build
.\scripts\dev.ps1 test
.\scripts\package.ps1 -IncludeTunnel
```

Source builds need access to Node, npm and official Tunnel downloads. These are maintainer build steps; Setup users need no Node/npm development environment. Builds and local tests do not publish automatically. See [Releases and upgrades](docs/发布与升级.md) for Setup builds and actual check results.

MIT · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Contributing](CONTRIBUTING.md) · [Xingdu icon](docs/图标与品牌.md)
