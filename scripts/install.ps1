[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexDotsBridge\data'),
  [string]$CodexHome,
  [string]$CodexCommand,
  [switch]$Autostart,
  [string]$TunnelId,
  [string]$OrganizationId,
  [string]$TunnelEnv,
  [string]$TunnelClient,
  [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
# Node's JSON and this guide use UTF-8, including redirected Windows PowerShell output.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'Windows x64 is required.' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = Join-Path $projectRoot 'runtime\node-v24.21.0-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { $nodeExe = Join-Path $projectRoot '.runtime\node-v24.21.0-win-x64\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Private Node runtime missing. Use the Windows package or scripts\bootstrap.ps1.' }
if ((& $nodeExe --version) -ne 'v24.21.0') { throw 'Private Node runtime version conflict.' }
$main = Join-Path $projectRoot 'dist\main.js'
if (-not (Test-Path -LiteralPath $main)) { throw 'Compiled bridge is missing. Build the project first.' }
if (-not $CodexCommand) {
  $discovery = "import {pathToFileURL} from 'node:url'; const {findCodexCommand}=await import(pathToFileURL(process.argv[1]).href); console.log(findCodexCommand());"
  $CodexCommand = (& $nodeExe --input-type=module -e $discovery (Join-Path $projectRoot 'dist\maintenance.js'))
  if ($LASTEXITCODE -ne 0) { throw 'Official Codex CLI is required. Install Codex desktop/CLI or pass -CodexCommand with the installed codex.exe path.' }
  $CodexCommand = ($CodexCommand -join '').Trim()
}
if (-not $CodexCommand -or -not (Test-Path -LiteralPath $CodexCommand -PathType Leaf)) { throw 'Official Codex CLI is required. Pass -CodexCommand with the installed codex.exe path.' }
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
function Invoke-BridgeJson([string[]]$CommandArgs) {
  $text = @(& $nodeExe $main @CommandArgs)
  if ($LASTEXITCODE -ne 0) {
    # CLI emits safe codes. Never echo arbitrary input, raw native stderr, or credential file contents.
    $code = 'bridge_operation_failed'
    try { $reported = ($text -join "`n") | ConvertFrom-Json; if ($reported.error -match '^[a-z][a-z0-9_]*$') { $code = $reported.error } } catch { }
    throw "Bridge operation failed: $code. Existing data is retained."
  }
  return (($text -join "`n") | ConvertFrom-Json)
}
$setupArgs = @('setup', '--data-dir', $DataDir, '--codex-command', $CodexCommand)
if ($CodexHome) { $setupArgs += @('--codex-home', [System.IO.Path]::GetFullPath($CodexHome)) }
if ($Autostart) { $setupArgs += '--autostart' }
# The existing CLI performs ownership and schema checks before this script reads public metadata.
$registration = Invoke-BridgeJson $setupArgs
$config = Get-Content -LiteralPath (Join-Path $DataDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.owner -ne 'codex-dots-bridge') { throw 'Owned production configuration is required.' }
Write-Output '本机 MCP/Skill 注册已完成；当前 Codex 对话是否加载仍为 pending。'
if (-not $TunnelId -and $config.tunnel) { $TunnelId = $config.tunnel.tunnel_id }
if (-not $OrganizationId -and $config.tunnel) { $OrganizationId = $config.tunnel.organization_id }
if (-not $TunnelEnv -and $config.tunnel) { $TunnelEnv = $config.tunnel.key_file }
if (-not $TunnelClient -and $config.tunnel) { $TunnelClient = $config.tunnel.client_path }
if (-not $TunnelClient) {
  foreach ($relative in @('vendor\tunnel-client-v0.0.16-windows-amd64\tunnel-client.exe', '.runtime\tunnel-client-v0.0.16-windows-amd64\tunnel-client.exe')) {
    $candidate = Join-Path $projectRoot $relative
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $TunnelClient = $candidate; break }
  }
}
$interactive = -not $NonInteractive -and [Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost'
try { if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { $interactive = $false } } catch { $interactive = $false }
if (@([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-(NonInteractive|NonI|noni)$' }).Count) { $interactive = $false }
if (-not $TunnelId -or -not $OrganizationId -or -not $TunnelEnv -or -not $TunnelClient) {
  Write-Output '首次连接待办：通过官方界面完成账号选择、Tunnel 权限、专用 runtime key 安全保存和私有插件配置。'
  Write-Output 'Tunnel 设置：https://platform.openai.com/settings/organization/tunnels'
  Write-Output '官方指南：https://developers.openai.com/api/docs/guides/secure-mcp-tunnels'
  Write-Output '私有插件：https://chatgpt.com/plugins'
  Write-Output '密钥保存流程与生产步骤：docs/首次连接.md。不要在本终端或聊天粘贴 key 正文。'
  if ($interactive) {
    Write-Output '已完成官方步骤时填写非秘密字段；任一项留空可稍后重跑安装。'
    if (-not $TunnelId) { $TunnelId = (Read-Host 'Tunnel ID（tunnel_ 开头，不是 key）').Trim() }
    if (-not $OrganizationId) { $OrganizationId = (Read-Host 'Organization ID（不是 key）').Trim() }
    if (-not $TunnelEnv) { $TunnelEnv = (Read-Host '已获官方确认并安全保存的 env 文件完整路径（不是文件内容）').Trim() }
    if (-not $TunnelClient) { $TunnelClient = (Read-Host '官方 Tunnel 客户端完整 EXE 路径（包内客户端缺失）').Trim() }
  }
}
$pending = @()
if (-not $TunnelId) { $pending += 'Tunnel ID' }
elseif ($TunnelId -notmatch '^tunnel_[A-Za-z0-9_-]+$') { $pending += '合法 Tunnel ID（不要输入 key）' }
if (-not $OrganizationId) { $pending += 'Organization ID' }
elseif ($OrganizationId -notmatch '^[A-Za-z0-9_-]{1,256}$' -or $OrganizationId -match '^sk-') { $pending += '合法 Organization ID（不要输入 key）' }
if (-not $TunnelEnv -or -not (Test-Path -LiteralPath $TunnelEnv -PathType Leaf)) { $pending += '已安全保存的 env 文件' }
if (-not $TunnelClient -or -not (Test-Path -LiteralPath $TunnelClient -PathType Leaf)) { $pending += '完整官方 Tunnel 客户端' }
if ($pending.Count) {
  Write-Output ('连接 pending，已保留本机安装；尚缺：' + ($pending -join '、'))
  Write-Output '完成官方步骤后重跑本入口；非交互可传 -TunnelId/-OrganizationId/-TunnelEnv/-TunnelClient。没有启动服务。'
} else {
  $TunnelEnv = [System.IO.Path]::GetFullPath($TunnelEnv)
  $TunnelClient = [System.IO.Path]::GetFullPath($TunnelClient)
  $changed = -not $config.tunnel -or $config.tunnel.tunnel_id -cne $TunnelId -or $config.tunnel.organization_id -cne $OrganizationId -or $config.tunnel.key_file -cne $TunnelEnv -or $config.tunnel.client_path -cne $TunnelClient
  $status = Invoke-BridgeJson @('status', '--data-dir', $DataDir)
  if ($changed -and ($status.supervisor -ne 'stopped' -or $status.service -ne 'stopped')) {
    Write-Output '连接参数修改 pending：本实例尚未完全停止。先执行本实例 run --stop，再重跑安装；未修改运行中的 Tunnel 配置。'
  } else {
    if ($changed) { $registration = Invoke-BridgeJson ($setupArgs + @('--tunnel-id', $TunnelId, '--organization-id', $OrganizationId, '--tunnel-client', $TunnelClient, '--tunnel-env', $TunnelEnv)) }
    if ($status.supervisor -eq 'stopped' -and $status.service -eq 'stopped') { $started = Invoke-BridgeJson @('run', '--data-dir', $DataDir) }
    else { Write-Output '复用本实例运行状态；未启动第二个服务。' }
    $doctor = Invoke-BridgeJson @('doctor', '--data-dir', $DataDir)
    Write-Output ('本机诊断：service={0}; supervisor={1}; tunnel={2}; tunnel_health={3}; plugin_subscription={4}' -f $doctor.service,$doctor.supervisor,$doctor.tunnel,$doctor.tunnel_health,$doctor.plugin_subscription)
    if ($doctor.tunnel_health -ne 'ready') { Write-Output 'Tunnel ready pending：请核对官方账号权限和连接，运行 doctor 排查；没有宣称云端已接通。' }
  }
}
Write-Output '真实验收 pending：新建 Codex 对话或重启后，确认九个工具：dots_submit、dots_list、dots_get、dots_wait、dots_message、dots_followup、dots_cancel、dots_status、dots_ack_result。'
Write-Output '在 Codex 实际调用 dots_status；让目标 Dot 发现 worker 工具并订阅 task.available / queue=tasks（callback/secret 由平台提供）。'
Write-Output '发送一条仅整理合成文本、无文件/消息/命令副作用的任务，按 task_id 读回结果；再验证用户回答后的同任务澄清续接。注册、ready 或本机诊断均不替代这些验收。'
