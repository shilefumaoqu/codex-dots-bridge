$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeDir = Join-Path $projectRoot '.runtime\node-v24.21.0-win-x64'
$nodeExe = Join-Path $nodeDir 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Run scripts\bootstrap.ps1 first.' }
$command = if ($args.Count -gt 0) { $args[0] } else { 'help' }
$forward = @($args | Select-Object -Skip 1)
if ($forward.Count -gt 0 -and $forward[0] -eq '--') { $forward = @($forward | Select-Object -Skip 1) }
$previousPath = $env:Path
Push-Location $projectRoot
try {
    $env:Path = "$nodeDir;$previousPath"
    switch ($command) {
        'install' {
            # Locked packages include their Windows x64 binaries; do not require a local C++ compiler.
            & $nodeExe (Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js') ci --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
            & $nodeExe --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();"
        }
        'build' { & $nodeExe 'node_modules\typescript\bin\tsc' -p tsconfig.json }
        'typecheck' { & $nodeExe 'node_modules\typescript\bin\tsc' --noEmit -p tsconfig.json }
        'test' { & $nodeExe --import tsx --test 'test/*.test.ts' }
        'bridge' { & $nodeExe --import tsx src/main.ts @forward }
        'probe' { & $nodeExe --import tsx src/cli.ts @forward }
        default { throw 'Usage: dev.ps1 install|build|typecheck|test|bridge|probe [-- command arguments]' }
    }
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE" }
} finally {
    $env:Path = $previousPath
    Pop-Location
}
