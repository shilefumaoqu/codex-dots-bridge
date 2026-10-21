<p align="center">
  <img src="docs/素材/星渡/星渡-应用-128.png" width="88" alt="Codex Dots Bridge icon">
</p>

<h1 align="center">Codex Dots Bridge</h1>

<p align="center">Hand work to your Dot, follow it in Codex, and retrieve the result.</p>

<p align="center">
  <a href="README.md">简体中文</a> · <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/tag/v0.2.0-alpha.30">v0.2.0-alpha.30</a> · Windows x64 · <a href="LICENSE">MIT</a>
</p>

<p align="center">
  <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/download/v0.2.0-alpha.30/Codex-Dots-Bridge-0.2.0-alpha.30-Setup.exe"><strong>Download the Windows installer</strong></a>
</p>

<p align="center">
  <a href="https://github.com/shilefumaoqu/codex-dots-bridge/releases/tag/v0.2.0-alpha.30">Windows ZIP, SHA256 files and full release notes</a>
</p>

> **Current release: 0.2.0-alpha.30 (experimental prerelease).** Includes startup recovery, tray reopening, stored-history and incremental handoff, a minimal chat entry and redacted diagnostics. ChatGPT-to-Dot continuous chat has not passed; later natural Events samples also expired without pickup. Read [acceptance and limits](ACCEPTANCE.md). A ready service does not prove a message round trip.

Codex Dots Bridge connects Codex to your existing Dot. Delegate a text task, then use the same task ID to follow progress, answer questions, add requirements and retrieve the result.

<p align="center">
  <img src="docs/素材/星渡/bridge-flow.svg" alt="Codex and Dot collaborate through Codex Dots Bridge" width="720">
</p>

## What the plugin does

| In Codex | Your Dot can | How the result follows through |
| --- | --- | --- |
| Submit a task and keep its ID | Receive the goal and text material | Check it later under the same task ID |
| Check progress, wait or answer a question | Report status or request clarification | Continue the original task |
| Add requirements or ask a follow-up | Work from the saved update | Keep a follow-up linked to its parent |
| Read results, cancel or resume a query | Save task results and stop status | Check execution, retrieval and acceptance separately |

<p align="center">
  <img src="docs/素材/星渡/task-workflow.svg" alt="Delegate a text task, follow progress and clarification, and retrieve the result" width="760">
</p>

A task moves from delegation to progress updates. Answer your Dot's questions on the same task, then retrieve its result by the original task ID.

You can also choose to let your Dot read the stored history of a local Codex conversation you specify, or ask that conversation to process text and retrieve its correlated turn reply. Local conversation access is optional and defaults to off. Enable `read` or `read-send` once on this computer; individual conversations do not need registration.

## Get started

**You need:** Windows 10/11 x64, your own Codex and Dot, and the account permissions for your OpenAI account, Secure MCP Tunnel, ChatGPT workspace private plugin and MCP Events. Tunnel requires a dedicated runtime key; a Codex subscription does not grant Tunnel permissions. This project does not call a model API or provide a free, no-login Tunnel.

1. Download and run the Setup above. It includes Node; you do not need to install Node or npm separately. The installer is unsigned, so Windows SmartScreen or organization policy may warn or block it. A SHA256 checksum is not a publisher signature.
2. Open **Codex Dots Bridge → First connection and maintenance** from Start. Follow the [first-connection guide](docs/首次连接.md) to connect your own official Tunnel, private plugin and Dot. Leave the connection `pending` until account authorization, runtime key and subscription are ready.
3. Enable the Bridge plugin in a new Codex conversation and call `dots_status` to inspect the actual connection state.
4. Submit a harmless text task, keep its `task_id`, then use that ID to check progress, answer questions and retrieve the result.

### Windows tray

<p align="center">
  <img src="docs/素材/星渡/tray-ready-demo.png" alt="Codex Dots Bridge alpha.21 tray rendered with a synthetic connection-ready state" width="420">
</p>

The alpha.21 program rendered this image with a synthetic status; “Connection ready” does not mean a specific message succeeded. Left-click to open status. Right-click to toggle start-at-login; closing the tray leaves the backend running.

For your first task, ask Codex:

> Give the text below to my Dot, organize it into three bullet points, and tell me the task ID once submitted.

Then query the original task and retrieve its result. Tunnel readiness, an accepted event subscription or a queued task does not mean that the Dot has completed and returned a result.

## Optional: connect a local Codex conversation

Local conversation reading and sending are separate optional capabilities and default to `off`. After enabling `read` or `read-send` once, you do not need to register conversations individually. You still specify the conversation and content for each operation.

<p align="center">
  <img src="docs/素材/星渡/conversation-handoff-alpha21.svg" alt="Read saved history through the official local App Server, or experimentally send text and retrieve its correlated new-turn reply" width="760">
</p>

Reading uses the official local App Server to page through saved history. Sending remains experimental and only retrieves the correlated reply from the specified conversation's new turn.

- **Read example:** “Read the stored history at this Codex conversation link and summarize the confirmed requirements.”
- **Send example:** “Send `17 × 19` to this Codex conversation and retrieve its reply from that turn.”

Reading all stored history pages does not guarantee the original model context is complete or recover material removed during compaction. If sending encounters a busy conversation, Bridge reports the state and asks you whether to wait for the next turn; adding to the current turn is unsupported. It does not automatically resend when the target is offline, unknown or the wait conditions change.

## Current status and experimental boundaries

Alpha.30 has targeted startup checks, dedicated review, package and local-upgrade evidence; see ACCEPTANCE.md. Historical alpha.21 passed its Windows installer, upgrade and recovery checks. A synthetic Codex-to-Dot task completed and was retrieved, and one user-initiated local-conversation send returned a real reply. Timely automatic Events pickup, busy/offline edge cases, recovery after a real reboot and long-term operation are not fully validated. A prior host tool-catalog rejection has no confirmed root cause; a later successful sample does not show that the issue is resolved.

[Historical alpha.21 Windows CI run](https://github.com/shilefumaoqu/codex-dots-bridge/actions/runs/38419703662) passed 35 of 38 checks; three legacy Git-history tests failed. The same source passed 38/38 locally, but the environment difference is unexplained and later CI build steps were skipped. A separate public-content privacy scan of 149 source files and 286 historical Git blobs found no issues; that does not mean the full CI passed.

The alpha is designed for one user, one Windows computer and one existing Dot, with default concurrency of 1. It is intended for testers willing to configure it and report issues; it is not a claim of compatibility with every account, device policy or unattended long-running setup.

## Guides

- [Quick start](docs/快速开始.md) · [First connection and Tunnel setup](docs/首次连接.md)
- [Task and tool contract](docs/任务与工具契约.md) · [Dot execution guide](docs/Dot执行说明.md)
- [Maintenance and troubleshooting](docs/维护与故障排查.md) · [Compatibility and known limits](docs/兼容性与已知限制.md)
- [Releases and upgrades](docs/发布与升级.md) · [Alpha.21 installation and recovery acceptance](docs/alpha21启动恢复验收.md) · [Security](SECURITY.md)

## Build from source

Maintainers can run these commands in Windows PowerShell:

```powershell
.\scripts\bootstrap.ps1
.\scripts\dev.ps1 install
.\scripts\dev.ps1 build
.\scripts\dev.ps1 test
.\scripts\package.ps1 -IncludeTunnel
```

Builds require Node/npm and access to the official Tunnel download source. A local build or test does not publish a GitHub Release. See the [contributing guide](CONTRIBUTING.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

---

This project is licensed under the [MIT License](LICENSE).
