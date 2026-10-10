import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { desktopConversationsConfigSchema } from './desktop-conversations.js';
import { acquireLock, protectProductionDirectory, readProductionConfig } from './runtime.js';
import { assertStopped } from './maintenance.js';
import { ProbeError } from './store.js';

function prepareDesktopAccess(dataDir: string, access: string, codexHome?: string) {
  if (!['off','read','read-send'].includes(access)) throw new ProbeError('invalid_desktop_access');
  const path = join(dataDir,'desktop-conversations.json');
  let previous: ReturnType<typeof desktopConversationsConfigSchema.parse> | undefined;
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new ProbeError('invalid_desktop_configuration');
    const parsed = desktopConversationsConfigSchema.safeParse(JSON.parse(readFileSync(path,'utf8')));
    if (!parsed.success) throw new ProbeError('invalid_desktop_configuration');
    previous = parsed.data;
  }
  const local = previous && 'mode' in previous && previous.mode === 'local' ? previous : undefined;
  const selectedHome = codexHome ?? local?.codex_home ?? process.env.CODEX_HOME ?? join(homedir(),'.codex');
  if (!isAbsolute(selectedHome) || selectedHome.includes('\0')) throw new ProbeError('invalid_codex_home');
  let resolvedHome = resolve(selectedHome);
  if (access !== 'off') try {
    if (!lstatSync(selectedHome).isDirectory() || lstatSync(selectedHome).isSymbolicLink()) throw new Error();
    resolvedHome = realpathSync.native(selectedHome);
  } catch { throw new ProbeError('codex_home_unavailable'); }
  const legacyTargets = local?.legacy_targets ?? (previous && 'targets' in previous ? previous.targets : undefined);
  const next = desktopConversationsConfigSchema.parse({enabled:access!=='off',mode:'local',codex_home:resolvedHome,read:access!=='off',send:access==='read-send',
    ...(legacyTargets?.length ? {legacy_targets:legacyTargets} : {})});
  return {path,next};
}

/** Validate setup before registering MCP; this never writes access settings. */
export function validateDesktopAccess(dataDir: string, access: string, codexHome?: string) {
  readProductionConfig(dataDir);
  assertStopped(dataDir);
  prepareDesktopAccess(dataDir,access,codexHome);
}

/** One local setup choice enables a capability; individual conversation IDs are not configuration. */
export function configureDesktopAccess(dataDir: string, access: string, codexHome?: string) {
  readProductionConfig(dataDir);
  assertStopped(dataDir);
  protectProductionDirectory(dataDir);
  const release = acquireLock(dataDir);
  try {
  const {path,next}=prepareDesktopAccess(dataDir,access,codexHome);
  const temporary = join(dataDir,`desktop-conversations.${randomUUID()}.tmp`);
  try { writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600}); renameSync(temporary,path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return {mode:access==='off'?'disabled':'local',read:access!=='off',send:access==='read-send',per_thread_configuration:false,requires_restart:true};
  } finally { release(); }
}
