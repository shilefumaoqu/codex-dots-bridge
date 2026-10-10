import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const defaultPolicy = JSON.parse(readFileSync(new URL('./public-release-policy.json', import.meta.url), 'utf8'));
const rules = [
  ['credential', /\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|whsec_[A-Za-z0-9+/=]{32,})/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['personal-path', /\b[A-Z]:[\\/]Users[\\/](?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b)|<|\$|%)[^\\/\s"']+/i],
  ['private-connection', /\b(?:plugin_)?asdk_app_[a-z0-9_]{20,}\b/],
  ['native-chat-id', /\b01[a-f0-9]{6}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/],
];
const privatePath = /(^|\/)(?:\.git|\.cache|secrets|backups|artifacts\/private)(\/|$)|(?:^|\/)\.env(?:\.(?!example$)[^/]+)?$|\.(?:sqlite(?:-.*)?|db(?:-.*)?|log|key|pem|pfx)$/i;
const textExtension = /\.(?:md|txt|csv|jsonl?|[cm]?js|tsx?|ps1|psm1|ya?ml|toml|ini|conf|config|xml|svg|html?|css|sh|bat|cmd|lock|map|cs|sql)$/i;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function isPublicDocument(path, policy = defaultPolicy) {
  return policy.documents.includes(path) || policy.assetPrefixes.some(prefix => path.startsWith(prefix));
}

export function publicFiles(root, path = '') {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const name = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return [name];
    return entry.isDirectory() ? publicFiles(root, name) : [name];
  });
}

export function scanBytes(bytes, path, policy = defaultPolicy) {
  const findings = [], warnings = [];
  if (privatePath.test(path)) findings.push({ path, rule: 'private-file' });
  if (/^docs\//i.test(path) && !isPublicDocument(path, policy)) findings.push({ path, rule: 'unapproved-public-document' });
  if (/\.(?:zip|7z|rar|tar|gz)$/i.test(path)) findings.push({ path, rule: 'nested-archive-needs-inspection' });
  const verified = policy.verifiedVendorFiles[path];
  if (verified) {
    if (digest(bytes) !== verified) findings.push({ path, rule: 'vendor-origin-hash-mismatch' });
    return { findings, warnings, coverage: 'verified-vendor', sha256: digest(bytes) };
  }
  let text;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    else if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { /* Coverage below is explicit; undecodable bytes are never called scanned. */ }
  if (text === undefined) {
    if (textExtension.test(path) || /(?:^|\/)(?:LICENSE|NOTICE)(?:\.|$)/i.test(path)) findings.push({ path, rule: 'unreadable-text' });
    warnings.push({ path, rule: 'binary-content-not-text-reviewed', sha256: digest(bytes) });
    return { findings, warnings, coverage: 'binary', sha256: digest(bytes) };
  }
  for (const [rule, pattern] of rules) {
    const match = pattern.exec(text);
    if (match) findings.push({ path, rule, line: text.slice(0, match.index).split('\n').length });
  }
  return { findings, warnings, coverage: 'text', sha256: digest(bytes) };
}

export function scanDirectory(root, paths = publicFiles(root), policy = defaultPolicy) {
  const report = { schema: 1, files: paths.length, coverage: { text: 0, binary: 0, 'verified-vendor': 0 }, findings: [], warnings: [] };
  for (const path of paths) {
    if (!path || path.includes('\\') || path.split('/').some(part => part === '..') || resolve(root, path) === resolve(root) || !resolve(root, path).startsWith(resolve(root) + '\\') && !resolve(root, path).startsWith(resolve(root) + '/')) {
      report.findings.push({ path, rule: 'unsafe-file-path' }); continue;
    }
    try {
      if (lstatSync(join(root, path)).isSymbolicLink()) { report.findings.push({ path, rule: 'symlink-not-inspected' }); continue; }
      const result = scanBytes(readFileSync(join(root, path)), path, policy);
      report.coverage[result.coverage]++;
      report.findings.push(...result.findings); report.warnings.push(...result.warnings);
      // Check our user-facing pages in the final tree, not upstream dependency READMEs.
      if (result.coverage === 'text' && /\.md$/i.test(path) && (!path.includes('/') || /^docs\//i.test(path))) {
        report.findings.push(...checkDocumentLinks(root, path));
      }
    } catch { report.findings.push({ path, rule: 'file-unreadable-or-changed' }); }
  }
  return report;
}

export function checkDocumentLinks(root, path) {
  const bytes = readFileSync(join(root, path));
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    .replace(/```[\s\S]*?```/g, block => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, block => ' '.repeat(block.length));
  const links = [...text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)]
    .map(match => ({ value: match[1] ?? match[2], index: match.index }));
  links.push(...[...text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => ({ value: match[1], index: match.index })));
  const labelKey = label => label.trim().replace(/\s+/g, ' ').toLowerCase();
  const definitions = new Map();
  for (const match of text.matchAll(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>]+)>|(\S+))/gm)) {
    const key = labelKey(match[1]);
    if (!definitions.has(key)) definitions.set(key, match[2] ?? match[3]);
  }
  for (const match of text.matchAll(/!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g)) {
    if (text[match.index + match[0].length] === '(' || text[match.index + match[0].length] === ':') continue;
    const value = definitions.get(labelKey(match[2] || match[1]));
    if (value) links.push({ value, index: match.index });
  }
  const findings = [];
  for (const link of links) {
    if (/^(?:https?:|mailto:|#)/i.test(link.value)) continue;
    let target, rule;
    try { target = decodeURIComponent(link.value.split(/[?#]/)[0]); } catch { rule = 'invalid-public-link'; }
    if (!rule && (/^[a-z][\w+.-]*:|^[\\/]/i.test(target))) rule = 'nonportable-public-link';
    if (!rule) {
      const resolved = resolve(dirname(join(root, path)), target);
      const fromRoot = relative(root, resolved);
      if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || /^[a-z]:/i.test(fromRoot)) rule = 'nonportable-public-link';
      else if (!existsSync(resolved)) rule = 'missing-public-link-target';
      else {
        let directory = root;
        for (const part of fromRoot.split(/[\\/]/).filter(Boolean)) {
          if (!readdirSync(directory).includes(part)) { rule = 'public-link-case-mismatch'; break; }
          directory = join(directory, part);
        }
      }
    }
    if (rule) findings.push({ path, rule, line: text.slice(0, link.index).split('\n').length });
  }
  return findings;
}

export function verifyReleaseEvidence(evidence, expected, evidenceRoot) {
  const failures = [];
  const fail = rule => failures.push(rule);
  if (evidence.schema !== 1 || evidence.mode !== 'real') fail('release-evidence-must-be-real');
  for (const key of ['version', 'sourceCommit', 'sourceZipSha256', 'windowsZipSha256', 'releaseNotesSha256']) if (!expected[key] || evidence[key] !== expected[key]) fail(`candidate-mismatch:${key}`);
  function proof(check, name) {
    if (!check || check.status !== 'passed' || check.mode !== 'real') { fail(`missing-real-check:${name}`); return; }
    const p = check.evidence;
    if (!p || typeof p.path !== 'string' || !p.path || !/^[a-f0-9]{64}$/.test(p.sha256 ?? '')) { fail(`missing-evidence-file:${name}`); return; }
    try { if (digest(readFileSync(resolve(evidenceRoot, p.path))) !== p.sha256) fail(`evidence-digest-mismatch:${name}`); }
    catch { fail(`evidence-file-unreadable:${name}`); }
  }
  proof(evidence.cleanInstall, 'clean-install');
  if (!['installed', 'started', 'uninstallPreservedData'].every(key => evidence.cleanInstall?.[key] === true)) fail('incomplete-clean-install');
  for (const direction of ['forward', 'reverse']) {
    const check = evidence.core?.[direction];
    proof(check, direction);
    if (!check || !['received', 'executed', 'resultStored', 'resultRetrieved'].every(key => check[key] === true)) fail(`incomplete-core:${direction}`);
    if (check?.taskKind !== 'ordinary-text' || !check.expectedTaskId || check.actualTaskId !== check.expectedTaskId) fail(`task-association:${direction}`);
    if (direction === 'reverse' && (!check?.expectedRequestId || check.actualRequestId !== check.expectedRequestId || !check.expectedTurnId || check.actualTurnId !== check.expectedTurnId)) fail('reverse-request-or-turn-mismatch');
  }
  proof(evidence.basicErrors, 'basic-errors');
  if (!['busy', 'offline', 'timeout', 'duplicate', 'wrongTarget'].every(name => evidence.basicErrors?.cases?.[name] === 'passed')) fail('basic-error-cases-missing');
  if (evidence.basicErrors?.uncertainAutoRetry !== false) fail('uncertain-send-may-retry');
  // Older ZIP-only releases remain compatible; declared Setup releases bind the exact installer too.
  const requiresSetup = expected.requiresSetup === true || expected.setupSha256 !== undefined || evidence.setupSha256 !== undefined || evidence.installUpgradeUninstall !== undefined || expected.version === '0.2.0-alpha.7';
  if (requiresSetup) {
    if (!/^[a-f0-9]{64}$/.test(expected.setupSha256 ?? '')) fail('missing-setup-artifact');
    if (!expected.setupSha256 || evidence.setupSha256 !== expected.setupSha256) fail('candidate-mismatch:setupSha256');
    const install = evidence.installUpgradeUninstall;
    proof(install, 'install-upgrade-uninstall');
    if (!expected.setupSha256 || install?.setupSha256 !== expected.setupSha256) fail('tested-setup-mismatch');
    if (!['installed','upgraded','uninstalled','uninstallPreservedData'].every(key => install?.[key] === true)) fail('incomplete-install-upgrade-uninstall');
    if (typeof install?.fromVersion !== 'string' || !install.fromVersion || install.fromVersion === expected.version || install.toVersion !== expected.version) fail('missing-cross-version-upgrade');
  }
  return failures;
}

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(arg('--root') ?? process.cwd());
  let report;
  try {
    report = scanDirectory(root);
    const notes = arg('--notes');
    if (notes) {
      const noteScan = scanBytes(readFileSync(notes), 'release-notes.md');
      report.findings.push(...noteScan.findings); report.warnings.push(...noteScan.warnings);
    }
    if (process.argv.includes('--require-evidence')) {
      const evidenceFile = arg('--evidence');
      if (!evidenceFile) report.findings.push({ path: 'release-evidence', rule: 'missing-release-evidence' });
      else {
        const expected = {
          version: arg('--version'), sourceCommit: arg('--commit'),
          sourceZipSha256: digest(readFileSync(arg('--source-zip'))),
          windowsZipSha256: digest(readFileSync(arg('--windows-zip'))),
          releaseNotesSha256: notes ? digest(readFileSync(notes)) : undefined,
          requiresSetup: process.argv.includes('--require-setup'),
          ...(arg('--setup-exe') ? { setupSha256: digest(readFileSync(arg('--setup-exe'))) } : {}),
        };
        const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
        for (const rule of verifyReleaseEvidence(evidence, expected, dirname(resolve(evidenceFile)))) report.findings.push({ path: 'release-evidence', rule });
        // This is a reviewer attestation tied to the exact binaries, not automatic image/installer inspection.
        for (const item of report.warnings) if (evidence.contentReview?.[item.path] !== item.sha256) report.findings.push({ path: item.path, rule: 'binary-review-not-bound-to-candidate' });
        if (evidence.privacyReview?.status !== 'passed' || evidence.privacyReview?.mode !== 'human') report.findings.push({ path: 'release-evidence', rule: 'missing-private-context-review' });
        proofPrivacy(evidence, dirname(resolve(evidenceFile)), report);
      }
    }
  } catch { report ??= { findings: [], warnings: [] }; report.findings.push({ path: 'release-input', rule: 'invalid-or-unreadable-input' }); }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.findings.length ? 1 : 0;
}

function proofPrivacy(evidence, base, report) {
  const p = evidence.privacyReview?.evidence;
  try {
    if (!p?.path || digest(readFileSync(resolve(base, p.path))) !== p.sha256) throw new Error('missing');
  } catch { report.findings.push({ path: 'release-evidence', rule: 'missing-privacy-review-evidence' }); }
}
