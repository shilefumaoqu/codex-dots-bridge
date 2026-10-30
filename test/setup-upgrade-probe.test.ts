import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const windows = process.platform === 'win32';
const probe = String.raw`
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=$env:DOTS_TEST_UPGRADE_PROBE|ConvertFrom-Json
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($request.lifecycle,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'lifecycle_parse_error'}
foreach($name in @('Get-UpgradeRuntimeStatus','Assert-NoInFlightTasks')){
  $definition=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if(-not $definition){throw 'missing_lifecycle_function'}
  . ([ScriptBlock]::Create($definition.Extent.Text))
}
# Only the executable layout and unavailable legacy status are adapters. The
# actual PS5 function launches real Node and reads a real legacy SQLite schema.
function Runtime-Node {return $request.node}
function Invoke-Bridge {throw 'legacy_status_unavailable'}
$env:BRIDGE_SETUP_TASK_PROBE='preserve original environment'
$status=$null;$failure=$null
try{$status=Get-UpgradeRuntimeStatus $request.root $request.dir;Assert-NoInFlightTasks $status}
catch{$failure=$_.Exception.Message}
if($env:BRIDGE_SETUP_TASK_PROBE -cne 'preserve original environment'){throw 'probe_environment_changed'}
@{powershell=$PSVersionTable.PSVersion.Major;status=$status;failure=$failure}|ConvertTo-Json -Depth 10 -Compress
`;

function inspect(directory: string) {
  return JSON.parse(execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: 'pipe',
    env: { ...process.env, DOTS_TEST_UPGRADE_PROBE: JSON.stringify({
      lifecycle: resolve('scripts/setup-lifecycle.ps1'), node: process.execPath,
      root: resolve('.'), dir: directory,
    }) },
  }));
}

test('PS5 legacy upgrade probe preserves quoted SQL, idle history and every accepted-work gate', { skip: !windows, timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "dots upgrade 中文 O'Brien $literal "));
  const file = join(dir, 'tasks.sqlite');
  try {
    const db = new Database(file);
    try {
      for (const table of ['tasks', 'desktop_conversation_requests', 'desktop_echo_requests', 'context_jobs']) {
        db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
      }
      db.prepare('INSERT INTO tasks VALUES (?,?)').run('completed', JSON.stringify({ status: 'completed', result: { id: 'stable-result', text: '历史正文' } }));
      for (let i = 0; i < 3; i++) db.prepare('INSERT INTO desktop_conversation_requests VALUES (?,?)').run(`old-${i}`, JSON.stringify({ result: { operation: 'send', status: 'uncertain' }, watch: { state: 'expired' } }));
    } finally { db.close(); }
    const original = readFileSync(file);
    const idle = inspect(dir);
    assert.equal(idle.powershell, 5);
    assert.equal(idle.failure, null);
    assert.deepEqual(idle.status.tasks, { completed: 1 });
    assert.equal(idle.status.maintenance_activity.total, 0);
    assert.deepEqual(readFileSync(file), original, 'read-only inspection must preserve historical identities and bytes');

    const cases: [string, object, string][] = [
      ['tasks', { status: 'queued' }, 'tasks'],
      ['desktop_conversation_requests', { result: { operation: 'send', status: 'awaiting_delivery_choice' } }, 'desktop_sends'],
      ['desktop_conversation_requests', { result: { operation: 'send', status: 'uncertain' }, watch: { state: 'active' } }, 'desktop_sends'],
      ['desktop_conversation_requests', { result: { operation: 'read', status: 'pending' } }, 'desktop_reads'],
      ['desktop_echo_requests', { result: { status: 'pending' } }, 'desktop_echo'],
      ['context_jobs', { status: 'pending' }, 'context_reads'],
    ];
    for (const [table, value, activity] of cases) {
      const db = new Database(file);
      try { db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run('active', JSON.stringify(value)); } finally { db.close(); }
      const before = readFileSync(file), observed = inspect(dir);
      assert.equal(observed.status.maintenance_activity[activity], 1, activity);
      assert.equal(observed.status.maintenance_activity.total, 1, activity);
      assert.match(observed.failure, activity === 'tasks' ? /^inflight_tasks_block_upgrade$/ : /^inflight_work_blocks_upgrade:/);
      assert.deepEqual(readFileSync(file), before, 'rejected upgrades must not advance or modify work');
      const cleanup = new Database(file);
      try { cleanup.prepare(`DELETE FROM ${table} WHERE id=?`).run('active'); } finally { cleanup.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PS5 legacy upgrade probe fails closed on unreadable task storage and restores its environment', { skip: !windows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots upgrade unreadable '));
  try {
    const file = join(dir, 'tasks.sqlite');
    writeFileSync(file, 'synthetic invalid SQLite file');
    const before = readFileSync(file), result = inspect(dir);
    assert.equal(result.failure, 'task_state_unavailable');
    assert.equal(result.status, null);
    assert.deepEqual(readFileSync(file), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
