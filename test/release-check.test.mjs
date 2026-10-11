import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { scanBytes, scanDirectory, verifyReleaseEvidence } from '../scripts/check-public-content.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = { status: 'passed', mode: 'real', evidence: { path: 'proof.txt', sha256: sha('synthetic test evidence only') } };
const expected = { version: '0.1.0-test', sourceCommit: 'a'.repeat(40), sourceZipSha256: 'b'.repeat(64), windowsZipSha256: 'c'.repeat(64), releaseNotesSha256: 'd'.repeat(64) };
function evidence() {
  const core = { ...check, taskKind: 'ordinary-text', received: true, executed: true, resultStored: true, resultRetrieved: true, expectedTaskId: 'synthetic-task', actualTaskId: 'synthetic-task' };
  return { schema: 1, mode: 'real', ...expected, cleanInstall: { ...structuredClone(check), installed: true, started: true, uninstallPreservedData: true }, core: { forward: structuredClone(core), reverse: { ...structuredClone(core), expectedRequestId: 'synthetic-request', actualRequestId: 'synthetic-request', expectedTurnId: 'synthetic-turn', actualTurnId: 'synthetic-turn' } }, basicErrors: { ...structuredClone(check), cases: { busy: 'passed', offline: 'passed', timeout: 'passed', duplicate: 'passed', wrongTarget: 'passed' }, uncertainAutoRetry: false } };
}
function setupEvidence(setupExpected) {
  return { ...evidence(), ...setupExpected, installUpgradeUninstall: { ...structuredClone(check), setupSha256: setupExpected.setupSha256, fromVersion: '0.1.0-test-old', toVersion: setupExpected.version, installed: true, upgraded: true, uninstalled: true, uninstallPreservedData: true } };
}
function scratch(fn) {
  const parent = process.env.BRIDGE_RELEASE_TEST_TMP ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'bridge-release-unit-'));
  try { writeFileSync(join(dir, 'proof.txt'), 'synthetic test evidence only'); return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function historicalDocumentCheck({ body, reviewedBody = body, current = false }) {
  return scratch(dir => {
    const path = 'docs/legacy-technical.md', version = '0.1.0-test';
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'docs'));
    for (const file of ['check-release.mjs', 'check-public-content.mjs']) copyFileSync(new URL('../scripts/' + file, import.meta.url), join(dir, 'scripts', file));
    writeFileSync(join(dir, 'scripts', 'public-release-policy.json'), JSON.stringify({ schema: 1, documents: [], assetPrefixes: [], verifiedVendorFiles: {}, reviewedHistoricalDocuments: { [path]: sha(reviewedBody) } }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
    writeFileSync(join(dir, 'src', 'bridge.ts'), `export const VERSION = '${version}';`);
    for (const file of ['README.md', 'README.en.md', 'CHANGELOG.md']) writeFileSync(join(dir, file), version);
    writeFileSync(join(dir, path), body);
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
    git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'Synthetic historical document');
    if (!current) { git('rm', path); git('commit', '-m', 'Remove synthetic document from current release'); }
    return spawnSync(process.execPath, ['scripts/check-release.mjs', ...(current ? [] : ['--history'])], { cwd: dir, encoding: 'utf8' });
  });
}

test('exact reviewed historical technical document passes the real Git history check', () => {
  const result = historicalDocumentCheck({ body: 'Synthetic legacy technical guidance.' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /History scanned:/);
});
test('changed historical bytes cannot reuse a prior document review', () => {
  const result = historicalDocumentCheck({ body: 'Changed synthetic technical guidance.', reviewedBody: 'Synthetic legacy technical guidance.' });
  assert.equal(result.status, 1); assert.match(result.stderr, /unapproved-public-document/);
});
test('reviewed historical document still fails credential inspection', () => {
  const result = historicalDocumentCheck({ body: 'Synthetic credential fixture: ghp_' + 'A'.repeat(36) });
  assert.equal(result.status, 1); assert.match(result.stderr, /credential/);
});
test('historical review never permits the same document in the current source tree', () => {
  const result = historicalDocumentCheck({ body: 'Synthetic legacy technical guidance.', current: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /unapproved-public-document/);
});

test('the previously missed personal report class is blocked without a secret', () => {
  // Synthetic category matching the old leaked documentation; no original private text.
  const result = scanBytes(Buffer.from('A personal deployment and conversation diary.'), 'docs/候选包验收.md');
  assert.ok(result.findings.some(x => x.rule === 'unapproved-public-document'));
});
test('approved technical documentation remains publishable', () => {
  assert.deepEqual(scanBytes(Buffer.from('Start the bridge with your own configuration.'), 'docs/快速开始.md').findings, []);
});
test('document directory case changes cannot bypass the public list', () => {
  for (const path of ['Docs/internal.md', 'DOCS/internal.md', 'Docs/快速开始.md']) assert.ok(scanBytes(Buffer.from('synthetic private record'), path).findings.some(x => x.rule === 'unapproved-public-document'));
});
test('final owned pages reject missing links but ignore examples and external URLs', () => scratch(dir => {
  writeFileSync(join(dir, 'README.md'), '[existing](target.md) [missing](docs/private.md)\n```md\n[example](not-real.md)\n```\n[web](https://example.invalid)');
  writeFileSync(join(dir, 'target.md'), 'synthetic public page');
  const findings = scanDirectory(dir).findings.filter(x => x.rule === 'missing-public-link-target');
  assert.equal(findings.length, 1); assert.equal(findings[0].path, 'README.md');
}));
test('final links cannot escape the published tree', () => scratch(dir => {
  writeFileSync(join(dir, 'README.md'), '[outside](../private.md) [local](C:/private.md)');
  assert.equal(scanDirectory(dir).findings.filter(x => x.rule === 'nonportable-public-link').length, 2);
}));
test('reference-style links use the same publication boundary checks', () => scratch(dir => {
  writeFileSync(join(dir, 'README.md'), '[outside][ref]\n[missing][]\n\n[ref]: ../private.md\n[missing]: absent.md\n```md\n[example][demo]\n[demo]: fake.md\n```');
  const findings = scanDirectory(dir).findings;
  assert.equal(findings.filter(x => x.rule === 'nonportable-public-link').length, 1);
  assert.equal(findings.filter(x => x.rule === 'missing-public-link-target').length, 1);
}));
test('link case must match actual filenames even on Windows', () => scratch(dir => {
  writeFileSync(join(dir, 'Target.md'), 'synthetic public page');
  writeFileSync(join(dir, 'README.md'), '[wrong](target.md)');
  assert.ok(scanDirectory(dir).findings.some(x => ['public-link-case-mismatch', 'missing-public-link-target'].includes(x.rule)));
  writeFileSync(join(dir, 'README.md'), '[right](Target.md)');
  assert.deepEqual(scanDirectory(dir).findings, []);
}));
test('a later reference definition cannot hide the first link target', () => scratch(dir => {
  writeFileSync(join(dir, 'README.md'), '[outside][ref]\n\n[ref]: ../private.md\n[ref]: https://example.invalid');
  assert.ok(scanDirectory(dir).findings.some(x => x.rule === 'nonportable-public-link'));
}));
test('legitimate synthetic CSV and JSON tests are retained', () => {
  for (const path of ['test/fixtures/accounts.csv', 'test/fixtures/response.json']) assert.deepEqual(scanBytes(Buffer.from('synthetic@example.invalid,example-only'), path).findings, []);
});
test('all text file extensions are scanned and findings do not echo secret values', () => {
  const secret = 'ghp_' + 'A'.repeat(36);
  for (const path of ['notes.txt', 'test.csv', 'setup.ps1', 'result.jsonl']) {
    const result = scanBytes(Buffer.from(secret), path);
    assert.ok(result.findings.some(x => x.rule === 'credential'));
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});
test('UTF-16 credentials are inspected', () => {
  const text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ghp_' + 'B'.repeat(36), 'utf16le')]);
  assert.ok(scanBytes(text, 'settings.txt').findings.some(x => x.rule === 'credential'));
});
test('undecodable declared text fails instead of silently passing', () => {
  assert.ok(scanBytes(Buffer.from([0xff, 0xfe, 1]), 'note.txt').findings.some(x => x.rule === 'unreadable-text'));
});
test('binary coverage is explicit and nested archives are not silently skipped', () => {
  const bytes = Buffer.from([0, 1, 2, 3]);
  assert.equal(scanBytes(bytes, 'image.png').coverage, 'binary');
  assert.ok(scanBytes(bytes, 'inner.zip').findings.some(x => x.rule === 'nested-archive-needs-inspection'));
});
test('runtime private data is rejected while .env.example remains allowed', () => {
  assert.ok(scanBytes(Buffer.from('sample'), '.env').findings.some(x => x.rule === 'private-file'));
  assert.ok(scanBytes(Buffer.from('sample'), 'tasks.sqlite').findings.some(x => x.rule === 'private-file'));
  assert.deepEqual(scanBytes(Buffer.from('TOKEN=<your-token>'), '.env.example').findings, []);
});
test('known vendor origin requires exact bytes, not just a trusted-looking path', () => {
  assert.ok(scanBytes(Buffer.from('wrong'), 'vendor/tunnel-client-v0.0.16-windows-amd64/tunnel-client.exe').findings.some(x => x.rule === 'vendor-origin-hash-mismatch'));
});
test('directory inspection detects actual extra documents', () => scratch(dir => {
  mkdirSync(join(dir, 'docs')); writeFileSync(join(dir, 'docs', '交付补齐记录.md'), 'synthetic personal record');
  assert.ok(scanDirectory(dir).findings.some(x => x.rule === 'unapproved-public-document'));
}));
test('complete candidate-bound evidence passes schema checking, not live acceptance', () => scratch(dir => {
  assert.deepEqual(verifyReleaseEvidence(evidence(), expected, dir), []);
}));
test('declared Setup evidence binds installer bytes and real install upgrade uninstall proof', () => scratch(dir => {
  const setupExpected = { ...expected, setupSha256: sha('synthetic setup bytes') };
  assert.deepEqual(verifyReleaseEvidence(setupEvidence(setupExpected), setupExpected, dir), []);
}));
test('alpha.7, alpha.8 and explicitly required Setup releases reject absent installers', () => scratch(dir => {
  for (const setupExpected of [{ ...expected, version: '0.2.0-alpha.7' }, { ...expected, version: '0.2.0-alpha.8' }, { ...expected, requiresSetup: true }]) {
    const value = { ...evidence(), version: setupExpected.version };
    assert.ok(verifyReleaseEvidence(value, setupExpected, dir).includes('missing-setup-artifact'));
  }
  const declared = setupEvidence({ ...expected, setupSha256: sha('synthetic setup bytes') });
  assert.ok(verifyReleaseEvidence(declared, expected, dir).includes('missing-setup-artifact'));
}));
test('unverified Setup cannot reuse ZIP clean installation evidence', () => scratch(dir => {
  const setupExpected = { ...expected, setupSha256: sha('synthetic setup bytes') }, value = setupEvidence(setupExpected);
  delete value.installUpgradeUninstall;
  assert.ok(verifyReleaseEvidence(value, setupExpected, dir).includes('missing-real-check:install-upgrade-uninstall'));
}));
test('wrong declared or tested Setup digests fail separately', () => scratch(dir => {
  const setupExpected = { ...expected, setupSha256: sha('synthetic setup bytes') };
  const declared = setupEvidence(setupExpected); declared.setupSha256 = 'f'.repeat(64);
  assert.ok(verifyReleaseEvidence(declared, setupExpected, dir).includes('candidate-mismatch:setupSha256'));
  const tested = setupEvidence(setupExpected); tested.installUpgradeUninstall.setupSha256 = 'f'.repeat(64);
  assert.ok(verifyReleaseEvidence(tested, setupExpected, dir).includes('tested-setup-mismatch'));
}));
test('same-version reinstall and incomplete uninstall are not upgrade acceptance', () => scratch(dir => {
  const setupExpected = { ...expected, setupSha256: sha('synthetic setup bytes') }, value = setupEvidence(setupExpected);
  value.installUpgradeUninstall.fromVersion = setupExpected.version;
  value.installUpgradeUninstall.uninstallPreservedData = false;
  const findings = verifyReleaseEvidence(value, setupExpected, dir);
  assert.ok(findings.includes('missing-cross-version-upgrade')); assert.ok(findings.includes('incomplete-install-upgrade-uninstall'));
}));
test('recompiled Setup bytes fail the CLI even with unchanged version ZIPs and release notes', () => scratch(dir => {
  const publicRoot = join(dir, 'public'); mkdirSync(publicRoot);
  const source = join(dir, 'source.zip'), windows = join(dir, 'windows.zip'), notes = join(dir, 'notes.md'), setup = join(dir, 'setup.exe'), evidencePath = join(dir, 'evidence.json');
  for (const [path, body] of [[source, 'synthetic source'], [windows, 'synthetic windows'], [notes, 'synthetic release notes'], [setup, 'synthetic setup bytes']]) writeFileSync(path, body);
  const setupExpected = { ...expected, sourceZipSha256: sha('synthetic source'), windowsZipSha256: sha('synthetic windows'), releaseNotesSha256: sha('synthetic release notes'), setupSha256: sha('synthetic setup bytes') };
  const value = setupEvidence(setupExpected); value.privacyReview = { status: 'passed', mode: 'human', evidence: structuredClone(check.evidence) }; value.contentReview = {};
  writeFileSync(evidencePath, JSON.stringify(value));
  const validate = () => spawnSync(process.execPath, ['scripts/check-public-content.mjs', '--root', publicRoot, '--require-evidence', '--version', setupExpected.version, '--commit', setupExpected.sourceCommit, '--source-zip', source, '--windows-zip', windows, '--notes', notes, '--setup-exe', setup, '--evidence', evidencePath], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const original = validate(); assert.equal(original.status, 0, original.stdout + original.stderr);
  writeFileSync(setup, 'synthetic recompiled setup bytes');
  const rebuilt = validate(); assert.equal(rebuilt.status, 1); assert.match(rebuilt.stdout, /candidate-mismatch:setupSha256/); assert.match(rebuilt.stdout, /tested-setup-mismatch/);
}));
test('accepted and fixed echo are insufficient', () => scratch(dir => {
  const value = evidence(); value.core.reverse.status = 'accepted'; value.core.reverse.taskKind = 'fixed-echo'; value.core.reverse.executed = false;
  const findings = verifyReleaseEvidence(value, expected, dir);
  assert.ok(findings.includes('missing-real-check:reverse'));
  assert.ok(findings.includes('incomplete-core:reverse'));
  assert.ok(findings.includes('task-association:reverse'));
}));
test('wrong original task, request and turn are rejected', () => scratch(dir => {
  const value = evidence(); value.core.reverse.actualTaskId = 'other'; value.core.reverse.actualRequestId = 'other'; value.core.reverse.actualTurnId = 'other';
  const findings = verifyReleaseEvidence(value, expected, dir);
  assert.ok(findings.includes('task-association:reverse')); assert.ok(findings.includes('reverse-request-or-turn-mismatch'));
}));
test('other candidate versions and artifact digests cannot reuse evidence', () => scratch(dir => {
  const value = evidence(); value.windowsZipSha256 = 'd'.repeat(64); value.version = 'old';
  const findings = verifyReleaseEvidence(value, expected, dir);
  assert.ok(findings.includes('candidate-mismatch:version')); assert.ok(findings.includes('candidate-mismatch:windowsZipSha256'));
}));
test('missing proof and simulated acceptance cannot count as real', () => scratch(dir => {
  const value = evidence(); value.mode = 'simulation'; value.cleanInstall.evidence.path = 'missing.txt';
  const findings = verifyReleaseEvidence(value, expected, dir);
  assert.ok(findings.includes('release-evidence-must-be-real')); assert.ok(findings.includes('evidence-file-unreadable:clean-install'));
}));
test('unknown sends do not permit automatic retry', () => scratch(dir => {
  const value = evidence(); value.basicErrors.uncertainAutoRetry = true;
  assert.ok(verifyReleaseEvidence(value, expected, dir).includes('uncertain-send-may-retry'));
}));
test('clean install and final release notes cannot be replaced by a status word', () => scratch(dir => {
  const value = evidence(); value.cleanInstall.started = false; value.releaseNotesSha256 = 'f'.repeat(64);
  const findings = verifyReleaseEvidence(value, expected, dir);
  assert.ok(findings.includes('incomplete-clean-install')); assert.ok(findings.includes('candidate-mismatch:releaseNotesSha256'));
}));
test('CLI fails closed when final release evidence is absent', () => scratch(dir => {
  const result = spawnSync(process.execPath, ['scripts/check-public-content.mjs', '--root', dir, '--require-evidence'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stdout, /missing-release-evidence/);
}));
