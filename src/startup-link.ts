import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { ProbeError } from './store.js';
import { createHash } from 'node:crypto';

export interface LegacyAutostart {kind?:'legacy-vbs';path:string;content:string}
export interface LinkAutostart {kind:'startup-link';path:string;content:string;launcher:string}
export type AutostartEntry=LegacyAutostart|LinkAutostart;
export interface LinkInspection {schema:1;path:string;exists:boolean;owned:boolean;content:string|null;windows:'enabled'|'disabled'|'unknown';legacy_windows:'enabled'|'disabled'|'unknown'}
export function startupPath(kind:'link'|'legacy'='link') {
  if(process.platform!=='win32'||!process.env.APPDATA)throw new ProbeError('autostart_windows_only');
  return join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup',kind==='link'?'CodexDotsBridge.lnk':'CodexDotsBridge.vbs');
}
function safe(path:string) {for(let p=resolve(path);;p=dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new ProbeError('unsafe_reparse_path');if(p===dirname(p))break;}}
function assertLauncherIdentity(launcher:string) {
  safe(launcher);if(!existsSync(launcher)||!lstatSync(launcher).isFile())throw new ProbeError('startup_launcher_missing');
  const installation=dirname(resolve(launcher)),actual=createHash('sha256').update(readFileSync(launcher)).digest('hex');
  for(const name of ['installation-state.json','.setup-transaction.json']){
    const path=join(installation,name);safe(path);if(!existsSync(path))continue;
    const record=JSON.parse(readFileSync(path,'utf8'));
    if(record.owner!=='codex-dots-bridge-setup'||record.schema!==1||resolve(record.install_directory)!==installation)continue;
    if(name==='installation-state.json'&&record.launcher_sha256===actual)return;
    if(name==='.setup-transaction.json'&&record.stable_startup===true&&(record.launcher_sha256===actual||record.launcher_candidate_sha256===actual))return;
  }
  throw new ProbeError('modified_or_foreign_launcher');
}
export function validateLauncher(entryPath:string,launcher:string) {
  const root=dirname(dirname(resolve(entryPath))),install=dirname(dirname(root));
  if(dirname(root)!==join(install,'payload')||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(root.slice(dirname(root).length+1))||resolve(launcher)!==join(install,'CodexDotsBridge.Launcher.exe'))throw new ProbeError('invalid_startup_launcher');
  assertLauncherIdentity(launcher);
  return resolve(launcher);
}
export function inspectStartupLink(launcher:string,action:'inspect'|'enable'|'disable'|'acknowledge'='inspect',expected?:string):LinkInspection {
  assertLauncherIdentity(launcher);
  const args=['--startup',action,...(expected===undefined?[]:['--expected',expected])];
  let text:string;
  try{text=execFileSync(launcher,args,{encoding:'utf8',windowsHide:true,stdio:'pipe',timeout:15000});}
  catch(error){
    try{const value=JSON.parse(String((error as {stdout?:unknown}).stdout??''));if(typeof value.error==='string'&&/^[a-z][a-z0-9_]*$/.test(value.error))throw new ProbeError(value.error);}catch(parsed){if(parsed instanceof ProbeError)throw parsed;}
    throw new ProbeError('startup_link_operation_failed');
  }
  let value:LinkInspection;try{value=JSON.parse(text.replace(/^\uFEFF/,'').trim()) as LinkInspection;}catch{throw new ProbeError('invalid_startup_link_receipt');}
  if(value.schema!==1||value.path!==startupPath()||typeof value.exists!=='boolean'||typeof value.owned!=='boolean'||!['enabled','disabled','unknown'].includes(value.windows)||!['enabled','disabled','unknown'].includes(value.legacy_windows)||(value.exists&&(typeof value.content!=='string'||!value.content.length)))throw new ProbeError('invalid_startup_link_receipt');
  return value;
}
export function prepareStartupLink(launcher:string,expected?:AutostartEntry):LinkAutostart {
  const current=inspectStartupLink(launcher);
  if(current.exists&&(!expected||expected.kind!=='startup-link'||expected.launcher!==launcher||current.content!==expected.content||!current.owned))throw new ProbeError('foreign_autostart_collision');
  if(current.windows!=='enabled'||current.legacy_windows!=='enabled')throw new ProbeError('autostart_disabled_or_unconfirmed_by_windows');
  const result=current.exists?current:inspectStartupLink(launcher,'enable');
  if(!result.exists||!result.owned||!result.content)throw new ProbeError('autostart_readback_failed');
  return {kind:'startup-link',path:result.path,content:result.content,launcher};
}
export function verifyAutostart(entry:AutostartEntry) {
  safe(entry.path);
  if(entry.kind==='startup-link') {
    const result=inspectStartupLink(entry.launcher);
    if(result.exists&&(!result.owned||result.content!==entry.content))throw new ProbeError('foreign_autostart_collision');
    return result.exists?(result.windows==='enabled'?'enabled':result.windows==='disabled'?'disabled':'unknown'):'disabled';
  }
  if(entry.path!==startupPath('legacy'))throw new ProbeError('invalid_installation_manifest');
  if(!existsSync(entry.path))return 'disabled';
  if(!lstatSync(entry.path).isFile()||readFileSync(entry.path,'utf8')!==entry.content)throw new ProbeError('foreign_autostart_collision');
  return 'enabled';
}
