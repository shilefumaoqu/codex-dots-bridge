import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { scanDirectory, scanBytes, isPublicDocument } from './check-public-content.mjs';

const root = process.cwd();
const failures = [];
const releasePolicy = JSON.parse(readFileSync(new URL('./public-release-policy.json', import.meta.url), 'utf8'));
const git = (...args) => execFileSync('git', args, {cwd: root, stdio:'pipe', maxBuffer: 32 * 1024 * 1024});
function sourceFiles(path='') {
  const excluded = new Set(['.git','.cache','.runtime','node_modules','dist','artifacts','coverage']);
  return readdirSync(join(root,path),{withFileTypes:true}).flatMap(entry=>{
    const name=path?path+'/'+entry.name:entry.name;
    if(entry.isDirectory())return excluded.has(entry.name)?[]:sourceFiles(name);
    return [name];
  });
}
let hasGit=true,files;
try {if(realpathSync.native(git('rev-parse','--show-toplevel').toString().trim())!==realpathSync.native(root))throw new Error('Not this source root');files=[...new Set(git('ls-files','-z','--cached','--others','--exclude-standard').toString().split('\0').filter(Boolean))];}
catch {hasGit=false;files=sourceFiles();}
if (process.argv.includes('--selected-public-documents')) {
  const selected = files.filter(file => !/^docs\//i.test(file) || isPublicDocument(file));
  console.log(`Not selected for publication: ${files.length-selected.length} internal documentation files.`);
  files = selected;
}
const forbiddenFile = /(^|\/)(?:\.cache|\.runtime|node_modules|dist|secrets|backups|artifacts)(\/|$)|\.(?:env|sqlite(?:-.*)?|db(?:-.*)?|log|zip|exe|key|pem|pfx)$/i;
const rules = [
  ['credential', /\bsk-[A-Za-z0-9_-]{24,}/g],
  ['webhook-secret', /\bwhsec_[A-Za-z0-9+/=]{32,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['personal-path', /\b[A-Z]:[\\/]Users[\\/](?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b))[^\\/\s"']+/gi],
  ['private-app', /\b(?:plugin_)?asdk_app_[a-z0-9_]{20,}/g],
  ['native-chat-id', /\b01[a-f0-9]{6}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g],
];
function scan(text, name) {
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) failures.push(`${name}: ${rule}, line ${text.slice(0, match.index).split('\n').length}`);
  }
}
for (const file of files) {
  if (forbiddenFile.test(file)) failures.push(`${file}: private/generated file is tracked`);
  if (!existsSync(file)) continue;
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  scan(text, file);
  if (!/\.md$/i.test(file)) continue;
  const links = [...text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)].map(m => m[1] ?? m[2]);
  links.push(...[...text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]));
  for (const link of links) {
    if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
    const path = decodeURIComponent(link.split('#')[0]);
    if (/^[a-z]+:|^[A-Z]:|^\//i.test(path)) { failures.push(`${file}: nonportable link`); continue; }
    if (!existsSync(resolve(dirname(file), path))) failures.push(`${file}: missing link target ${path}`);
  }
}
const publicContent = scanDirectory(root, files.filter(file => existsSync(file)));
for (const finding of publicContent.findings) failures.push(`${finding.path}: ${finding.rule}${finding.line ? ', line '+finding.line : ''}`);
console.log(`Public content coverage: ${JSON.stringify(publicContent.coverage)}; ${publicContent.warnings.length} files require non-text review.`);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const bridge = readFileSync('src/bridge.ts', 'utf8').match(/export const VERSION = '([^']+)'/)?.[1];
if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version || bridge !== pkg.version) failures.push('Project/lock/runtime version mismatch');
for (const file of ['README.md','README.en.md','CHANGELOG.md']) if (!readFileSync(file,'utf8').includes(pkg.version)) failures.push(`${file}: current version missing`);
if (process.argv.includes('--history')) {
  if(!hasGit) {console.error('History scan requires a Git repository; normal source archive checks do not.');process.exit(1);}
  const blobs = new Set();
  for (const record of git('rev-list','--objects','--all').toString().trim().split('\n')) {
    const [sha, ...parts] = record.split(' '); const name = parts.join(' ');
    if (!name || blobs.has(sha)) continue;
    const kind = git('cat-file','-t',sha).toString().trim();
    if (kind !== 'blob') continue;
    blobs.add(sha);
    if (forbiddenFile.test(name)) failures.push(`history:${name}: private/generated file`);
    const bytes = git('cat-file','blob',sha);
    const historyScan = scanBytes(bytes, name);
    // A past technical document review applies only to these exact bytes, never the current tree.
    const reviewed = releasePolicy.reviewedHistoricalDocuments?.[name] === createHash('sha256').update(bytes).digest('hex');
    for (const finding of historyScan.findings) {
      if (reviewed && finding.rule === 'unapproved-public-document') continue;
      failures.push(`history:${sha.slice(0,8)}:${finding.path}: ${finding.rule}`);
    }
  }
  console.log(`History scanned: ${blobs.size} unique blobs`);
}
console.log(`Release source check: ${files.length} files, version ${pkg.version}, ${failures.length} failures`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
