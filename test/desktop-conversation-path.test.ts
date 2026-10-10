import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeConversationPath, resolveConversationPath } from '../src/desktop-conversation-path.js';

test('normalizes Windows local extended drive paths, rejects device/UNC/ADS namespaces', () => {
  assert.equal(normalizeConversationPath(String.raw`\\?\C:\Synthetic\.codex\sessions\a.jsonl`), String.raw`C:\Synthetic\.codex\sessions\a.jsonl`);
  assert.equal(normalizeConversationPath('C:/Synthetic/.codex/sessions/../archived_sessions/a.jsonl'), String.raw`C:\Synthetic\.codex\archived_sessions\a.jsonl`);
  for (const value of [String.raw`\\?\UNC\host\share\a`, String.raw`\\host\share\a`, String.raw`\\.\pipe\codex-ipc`, String.raw`\\?\GLOBALROOT\Device\a`, 'C:\\home\\sessions\\a.jsonl:private', 'C:\\home\\sessions\\.. \\outside', 'relative.jsonl']) assert.throws(() => normalizeConversationPath(value), /target_path_invalid/);
});
test('exact existing files only under sessions/archived_sessions; no discovery or directory targets', () => {
  const home = mkdtempSync(join(tmpdir(), 'conversation-path-')); mkdirSync(join(home, 'sessions')); mkdirSync(join(home, 'archived_sessions'));
  const active = join(home, 'sessions', 'a.jsonl'), archived = join(home, 'archived_sessions', 'b.jsonl'); writeFileSync(active, 'a'); writeFileSync(archived, 'b');
  try {
    assert.equal(resolveConversationPath(active, home).toLowerCase(), active.toLowerCase()); assert.equal(resolveConversationPath(archived, home).toLowerCase(), archived.toLowerCase());
    if (process.platform === 'win32') assert.equal(resolveConversationPath('\\\\?\\' + active, '\\\\?\\' + home).toLowerCase(), active.toLowerCase());
    assert.throws(() => resolveConversationPath(join(home, 'outside.jsonl'), home), /target_path_invalid/);
    assert.throws(() => resolveConversationPath(join(home, 'sessions-extra', 'a.jsonl'), home), /target_path_invalid/);
    assert.throws(() => resolveConversationPath(join(home, 'sessions', 'missing.jsonl'), home), /log_unavailable/);
    assert.throws(() => resolveConversationPath(join(home, 'sessions'), home), /target_path_invalid/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('symlink/junction redirections in target or home are rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'conversation-path-link-')); const home = join(root, 'home'), outside = join(root, 'outside'); mkdirSync(home); mkdirSync(outside); writeFileSync(join(outside, 'a.jsonl'), 'a');
  try {
    try { symlinkSync(outside, join(home, 'sessions'), 'junction'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; t.skip('sandbox denies synthetic junction creation'); return; }
    assert.throws(() => resolveConversationPath(join(home, 'sessions', 'a.jsonl'), home), /target_path_invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
