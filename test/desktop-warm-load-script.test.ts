import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = fileURLToPath(new URL('../scripts/desktop-warm-load.ps1', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Receipt = { mode: string; reason: string; message_attempted: boolean; navigation_state: string };

test('real PowerShell 5.1 -File omitted cwd reaches read-only endpoint validation', { skip: !windows }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'dots-warm-probe-'));
  try {
    const binding = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-Process -Id ${process.pid}; [pscustomobject]@{start=$p.StartTime.ToUniversalTime().ToString('o');exe=$p.Path}|ConvertTo-Json -Compress`],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()) as { start: string; exe: string };
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', 'Probe',
      '-ExpectedProcessId', String(process.pid), '-ExpectedStartTimeUtc', binding.start, '-ExpectedExePath', binding.exe, '-UserDataDir', fixture];
    const receipt = JSON.parse(execFileSync(powershell, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()) as Receipt;
    assert.equal(receipt.mode, 'Probe'); assert.equal(receipt.reason, 'endpoint_missing');
    assert.equal(receipt.message_attempted, false); assert.equal(receipt.navigation_state, 'not_attempted');

    // -Command preserves an explicitly empty argument on Windows PowerShell.
    // Only the owned fixture process is inspected. No AutoDiscover or navigation.
    const command = `& ${quote(script)} -Mode Probe -ExpectedProcessId ${process.pid} -ExpectedStartTimeUtc ${quote(binding.start)} -ExpectedExePath ${quote(binding.exe)} -UserDataDir ${quote(fixture)} -WorkingDirectory `;
    for (const invalid of ['', '.', 'bad"path', 'bad\npath']) {
      const rejected = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command + quote(invalid)],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()) as Receipt;
      assert.equal(rejected.reason, 'validation_or_probe_error'); assert.equal(rejected.message_attempted, false);
      assert.equal(rejected.navigation_state, 'not_attempted');
    }
  } finally { rmdirSync(fixture); }
});
