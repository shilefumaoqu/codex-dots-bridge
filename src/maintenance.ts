import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, copyFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initProduction, readProductionConfig, writeProductionConfig, protectProductionDirectory } from './runtime.js';
import { ProbeError } from './store.js';

const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
function regular(path:string) { if(lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new ProbeError('unsafe_file'); }
export function processIsAlive(pid:number) { if(!Number.isSafeInteger(pid)||pid<1)throw new ProbeError('invalid_process_id');try {process.kill(pid,0);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;return true;} }
export function assertStopped(dir:string) {
  for(const name of ['service.lock','supervisor.lock']) if(existsSync(join(dir,name))) {
    regular(join(dir,name));const lock=JSON.parse(readFileSync(join(dir,name),'utf8')) as {pid:number};
    if(processIsAlive(lock.pid)) throw new ProbeError('stop_service_first');
    throw new ProbeError('stale_lock_requires_recovery');
  }
}
export function statusData(dir:string) {
  const config=readProductionConfig(dir);
  const service=existsSync(join(dir,'service.lock'))?JSON.parse(readFileSync(join(dir,'service.lock'),'utf8')) as {pid:number}:undefined;
  const counts:Record<string,number>={};let subscriptions=0;
  const dbPath=join(dir,'tasks.sqlite');
  if(existsSync(dbPath)) {
    regular(dbPath);const db=new Database(dbPath,{readonly:true,fileMustExist:true});
    try {
      const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(t=>t.name);
      if(tables.includes('tasks')) for(const row of db.prepare('SELECT data FROM tasks').all() as {data:string}[]) {const task=JSON.parse(row.data) as {status:string};counts[task.status]=(counts[task.status]??0)+1;}
      if(tables.includes('task_subscriptions')) for(const row of db.prepare('SELECT data FROM task_subscriptions').all() as {data:string}[]) {const sub=JSON.parse(row.data) as {active:boolean;expires_at:number};if(sub.active&&sub.expires_at>Date.now())subscriptions++;}
    } finally {db.close();}
  }
  return {instance_id:config.instance_id,service:service?(processIsAlive(service.pid)?'running':'stale_lock'):'stopped',endpoint:config.endpoint??null,tunnel_configured:!!config.tunnel,plugin_subscription:subscriptions?'active':'missing_or_expired',tasks:counts,codex_tools:'requires_real_call_after_restart',task_bodies:'redacted'};
}
export async function connectionDiagnosticsData(dir:string) {
  const config=readProductionConfig(dir);
  if(!config.tunnel) return {tunnel_configured:false,tunnel_health:'not_configured' as const};
  let tunnel_health:'unknown'|'ready'|'not_ready'|'unreachable'='unknown';
  if(existsSync(join(dir,'tunnel-health.url'))) {
    const u=new URL(readFileSync(join(dir,'tunnel-health.url'),'utf8').trim());
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/') throw new ProbeError('invalid_tunnel_health_endpoint');
    try {const result=await fetch(new URL('readyz',u),{signal:AbortSignal.timeout(1500),redirect:'error'});tunnel_health=result.ok?'ready':'not_ready';}catch{tunnel_health='unreachable';}
  }
  return {tunnel_configured:true,tunnel_health};
}
export async function doctorData(dir:string) {
  const status=statusData(dir),config=readProductionConfig(dir),checks:Record<string,unknown>={...status};
  checks.tunnel_client=config.tunnel&&existsSync(config.tunnel.client_path)?'present':'missing';
  checks.runtime_key=config.tunnel&&existsSync(config.tunnel.key_file)?'file_present_not_authenticated':'missing';
  checks.mcp_registration=existsSync(join(dir,'installation.json'))?'manifest_present_not_loaded':'not_installed';
  Object.assign(checks,await connectionDiagnosticsData(dir));
  checks.account_authorization='requires_official_account_flow';checks.dot_binding='requires_target_dot_subscription_and_real_task';
  return checks;
}
interface BackupManifest {owner:'codex-dots-bridge-backup';schema_version:1;instance_id:string;files:Record<string,string>}
function pathsOverlap(a:string,b:string) {
  const key=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
  const left=key(a),right=key(b);
  return left===right||left.startsWith(right+sep)||right.startsWith(left+sep);
}
export async function backupData(dir:string,destination:string) {
  protectProductionDirectory(dir);const config=readProductionConfig(dir),target=resolve(destination);
  if(pathsOverlap(dir,target))throw new ProbeError('backup_path_conflict');
  if(existsSync(target)&&readdirSync(target).length)throw new ProbeError('backup_destination_not_empty');
  initProduction(target);
  const files=['config.json','caller.key','worker.key'];
  for(const name of ['caller.key','worker.key'])copyFileSync(join(dir,name),join(target,name));
  if(existsSync(join(dir,'tasks.sqlite'))) {
    const db=new Database(join(dir,'tasks.sqlite'),{readonly:true,fileMustExist:true});
    try {await db.backup(join(target,'tasks.sqlite'));}finally{db.close();}files.push('tasks.sqlite');
  }
  const {endpoint:_endpoint,installation:_installation,...saved}=config;
  if(saved.tunnel) {
    regular(saved.tunnel.key_file);copyFileSync(saved.tunnel.key_file,join(target,'tunnel-runtime.env'));
    saved.tunnel={...saved.tunnel,key_file:join(target,'tunnel-runtime.env')};files.push('tunnel-runtime.env');
  }
  writeProductionConfig(target,saved);
  const manifest:BackupManifest={owner:'codex-dots-bridge-backup',schema_version:1,instance_id:config.instance_id,files:Object.fromEntries(files.map(name=>[name,digest(join(target,name))]))};
  writeFileSync(join(target,'backup-manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});protectProductionDirectory(target);
  return {backup_directory:target,consistent_sqlite:true,recovery_credentials_included:!!saved.tunnel,contains_secrets:true};
}
export function restoreData(backup:string,targetDir:string) {
  const source=resolve(backup),target=resolve(targetDir);
  if(pathsOverlap(source,target))throw new ProbeError('restore_path_conflict');
  assertStopped(target);
  protectProductionDirectory(source);
  const manifest=JSON.parse(readFileSync(join(source,'backup-manifest.json'),'utf8')) as BackupManifest;
  if(manifest.owner!=='codex-dots-bridge-backup'||manifest.schema_version!==1)throw new ProbeError('invalid_backup_manifest');
  const allowed=new Set(['config.json','caller.key','worker.key','tasks.sqlite','tunnel-runtime.env']);
  if(!manifest.files['config.json']||!manifest.files['caller.key']||!manifest.files['worker.key'])throw new ProbeError('incomplete_backup');
  for(const [name,sum] of Object.entries(manifest.files)) {if(!allowed.has(name))throw new ProbeError('invalid_backup_entry');regular(join(source,name));if(digest(join(source,name))!==sum)throw new ProbeError('backup_integrity_failed');}
  const config=readProductionConfig(source);if(config.instance_id!==manifest.instance_id)throw new ProbeError('backup_instance_mismatch');
  if(config.tunnel&&!manifest.files['tunnel-runtime.env'])throw new ProbeError('backup_key_missing');
  if(existsSync(target)&&readdirSync(target).length)throw new ProbeError('restore_destination_not_empty');
  initProduction(target);
  for(const name of Object.keys(manifest.files))if(name!=='config.json')copyFileSync(join(source,name),join(target,name));
  if(config.tunnel)config.tunnel={...config.tunnel,key_file:join(target,'tunnel-runtime.env')};
  delete config.endpoint;delete config.installation;writeProductionConfig(target,config);protectProductionDirectory(target);
  return {restored_directory:target,instance_id:config.instance_id,mcp_registration:'run_setup_again',dot_binding:'verify_subscription_after_start'};
}
export interface InstallOptions {nodePath:string;entryPath:string;skillSource:string;codexHome?:string;codexCommand?:string;autostart?:boolean}
interface InstallManifest {owner:'codex-dots-bridge';instance_id:string;codex_home:string;codex_command:string;mcp:{name:string;command:string;args:string[]};mcp_registration?:unknown;skill:{path:string;files:Record<string,string>};autostart?:{path:string;content:string}}
function safePath(path:string) {
  for(let cursor=resolve(path);;cursor=dirname(cursor)){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw new ProbeError('symlink_installation_path');if(cursor===dirname(cursor))break;}
}
function tree(root:string,prefix=''):Record<string,string> {
  if(lstatSync(root).isSymbolicLink())throw new ProbeError('symlink_skill');
  const files:Record<string,string>={};
  for(const name of readdirSync(root)) {const path=join(root,name),key=prefix?prefix+'/'+name:name;const info=lstatSync(path);if(info.isSymbolicLink())throw new ProbeError('symlink_skill');if(info.isDirectory())Object.assign(files,tree(path,key));else if(info.isFile())files[key]=digest(path);else throw new ProbeError('unsafe_skill');}
  return files;
}
function ownedSkill(actual:Record<string,string>,expected:Record<string,string>) {return Object.entries(actual).every(([name,sum])=>expected[name]===sum);}
export function resolveCodexNpmShim(shim:string) {
  const prefix=dirname(resolve(shim));
  const packageRoot=join(prefix,'node_modules','@openai','codex');
  const candidates=[
    join(packageRoot,'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'),
    join(prefix,'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'),
    join(packageRoot,'vendor','x86_64-pc-windows-msvc','bin','codex.exe'),
    join(packageRoot,'vendor','x86_64-pc-windows-msvc','codex','codex.exe'),
  ];
  for(const candidate of candidates)if(existsSync(candidate)&&lstatSync(candidate).isFile())return candidate;
  throw new ProbeError('official_codex_cli_missing_pass_codex_command');
}
export function findCodexCommand() {
  if(process.platform!=='win32')return 'codex';
  const script=String.raw`$ErrorActionPreference='Stop'
$found=Get-Command codex.exe -ErrorAction SilentlyContinue
if($found){[Console]::Write($found.Source);exit 0}
$root=Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
if(Test-Path -LiteralPath $root){foreach($dir in (Get-ChildItem -LiteralPath $root -Directory | Sort-Object LastWriteTimeUtc -Descending)){$exe=Join-Path $dir.FullName 'codex.exe';if(Test-Path -LiteralPath $exe -PathType Leaf){[Console]::Write($exe);exit 0}}}
$shim=Get-Command codex.cmd -ErrorAction SilentlyContinue
if($shim){[Console]::Write($shim.Source);exit 0}
exit 3`;
  try{const found=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,stdio:'pipe',timeout:15000}).trim();return found.toLowerCase().endsWith('.cmd')?resolveCodexNpmShim(found):found;}catch{throw new ProbeError('official_codex_cli_missing_pass_codex_command');}
}
function runCodex(command:string,home:string,args:string[]) {
  try{return execFileSync(command,args,{encoding:'utf8',env:{...process.env,CODEX_HOME:home},windowsHide:true,stdio:'pipe',timeout:30000});}catch{throw new ProbeError('codex_cli_operation_failed');}
}
function mcpEntry(command:string,home:string,name:string) {
  const list=JSON.parse(runCodex(command,home,['mcp','list','--json'])) as {name:string;transport:{type:string;command?:string;args?:string[]}}[];
  return list.find(entry=>entry.name===name);
}
function entryMatches(entry:ReturnType<typeof mcpEntry>,expected:InstallManifest['mcp'],snapshot?:unknown) {return !!entry&&entry.transport.type==='stdio'&&entry.transport.command===expected.command&&JSON.stringify(entry.transport.args??[])===JSON.stringify(expected.args)&&(snapshot===undefined||JSON.stringify(entry)===JSON.stringify(snapshot));}
function readInstall(dir:string):InstallManifest|undefined {
  const path=join(dir,'installation.json');if(!existsSync(path))return;
  regular(path);const value=JSON.parse(readFileSync(path,'utf8')) as InstallManifest;
  if(value.owner!=='codex-dots-bridge'||value.instance_id!==readProductionConfig(dir).instance_id)throw new ProbeError('foreign_installation_manifest');
  if(value.mcp.name!=='codex-dots-bridge'||value.skill.path!==join(value.codex_home,'skills','codex-dots-bridge')||value.mcp.args.length!==4||value.mcp.args[1]!=='stdio'||value.mcp.args[2]!=='--data-dir'||value.mcp.args[3]!==resolve(dir))throw new ProbeError('invalid_installation_manifest');
  safePath(value.skill.path);
  for(const name of Object.keys(value.skill.files)) {const path=resolve(value.skill.path,name);if(!path.startsWith(resolve(value.skill.path)+sep))throw new ProbeError('invalid_installation_manifest');}
  if(value.autostart&&value.autostart.path!==join(process.env.APPDATA??'','Microsoft','Windows','Start Menu','Programs','Startup','CodexDotsBridge.vbs'))throw new ProbeError('invalid_installation_manifest');
  return value;
}
export function installCodex(dir:string,options:InstallOptions) {
  protectProductionDirectory(dir);const config=readProductionConfig(dir),previous=readInstall(dir);
  const home=resolve(options.codexHome??process.env.CODEX_HOME??join(homedir(),'.codex')),command=options.codexCommand??findCodexCommand();
  safePath(home);safePath(join(home,'skills','codex-dots-bridge'));safePath(options.skillSource);
  const mcp={name:'codex-dots-bridge',command:resolve(options.nodePath),args:[resolve(options.entryPath),'stdio','--data-dir',resolve(dir)]};
  regular(mcp.command);regular(mcp.args[0]!);const skillFiles=tree(resolve(options.skillSource)),skillPath=join(home,'skills','codex-dots-bridge');
  if(!skillFiles['SKILL.md'])throw new ProbeError('skill_source_missing');
  if(previous&&(previous.codex_home!==home||previous.codex_command!==command||JSON.stringify(previous.mcp)!==JSON.stringify(mcp)))throw new ProbeError('installation_change_requires_uninstall');
  const existing=mcpEntry(command,home,mcp.name);
  if(existing&&(!previous||!entryMatches(existing,previous.mcp,previous.mcp_registration)))throw new ProbeError('foreign_mcp_collision');
  if(existsSync(skillPath)&&(!previous||!ownedSkill(tree(skillPath),previous.skill.files)))throw new ProbeError('foreign_or_modified_skill_collision');
  if(previous&&JSON.stringify(skillFiles)!==JSON.stringify(previous.skill.files))throw new ProbeError('skill_upgrade_requires_uninstall');
  const manifest:InstallManifest={owner:'codex-dots-bridge',instance_id:config.instance_id,codex_home:home,codex_command:command,mcp,mcp_registration:previous?.mcp_registration,skill:{path:skillPath,files:skillFiles}};
  if(options.autostart) {
    if(process.platform!=='win32'||!process.env.APPDATA)throw new ProbeError('autostart_windows_only');
    const path=join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup','CodexDotsBridge.vbs');
    const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
    const launch=[mcp.command,mcp.args[0]!,'run','--data-dir',resolve(dir)].map(v=>'"'+v+'"').join(' ');
    const content='Set shell = CreateObject("WScript.Shell")\r\nshell.Run '+quote(launch)+', 0, False\r\n';
    if(existsSync(path)&&(!previous?.autostart||previous.autostart.path!==path||readFileSync(path,'utf8')!==previous.autostart.content))throw new ProbeError('foreign_autostart_collision');
    manifest.autostart={path,content};
  }else if(previous?.autostart)manifest.autostart=previous.autostart;
  if(manifest.autostart) {
    safePath(manifest.autostart.path);
    if(existsSync(manifest.autostart.path)) {
      regular(manifest.autostart.path);
      if(readFileSync(manifest.autostart.path,'utf8')!==manifest.autostart.content)throw new ProbeError('foreign_autostart_collision');
    }
  }
  // Record intent before registrations so a failed step remains recoverable and owns only exact matching content.
  writeFileSync(join(dir,'installation.json'),JSON.stringify(manifest,null,2),{mode:0o600});protectProductionDirectory(dir);
  if(!existing)runCodex(command,home,['mcp','add',mcp.name,'--',mcp.command,...mcp.args]);
  const registered=mcpEntry(command,home,mcp.name);
  if(!entryMatches(registered,mcp))throw new ProbeError('mcp_registration_readback_failed');
  manifest.mcp_registration=registered;writeFileSync(join(dir,'installation.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  mkdirSync(skillPath,{recursive:true});
  for(const name of Object.keys(skillFiles)){const path=join(skillPath,name);mkdirSync(dirname(path),{recursive:true});copyFileSync(join(options.skillSource,name),path);}
  if(manifest.autostart){mkdirSync(dirname(manifest.autostart.path),{recursive:true});writeFileSync(manifest.autostart.path,manifest.autostart.content);}
  return {mcp:'registered',skill:'installed',autostart:!!manifest.autostart,codex_tools:'pending_restart_or_new_chat_and_real_call'};
}
export function uninstallCodex(dir:string,codexCommand?:string) {
  assertStopped(dir);const manifest=readInstall(dir);if(!manifest)return {removed:[],retained:['task_data','credentials'],installation:'not_owned'};
  const removed:string[]=[],retained:string[]=['task_data','credentials'];
  // An explicit replacement CLI can inspect the original owned registration after a desktop upgrade removes its old executable.
  const command=codexCommand??manifest.codex_command;
  const entry=mcpEntry(command,manifest.codex_home,manifest.mcp.name);
  if(entryMatches(entry,manifest.mcp,manifest.mcp_registration)){runCodex(command,manifest.codex_home,['mcp','remove',manifest.mcp.name]);removed.push('mcp');}else if(entry)retained.push('modified_or_foreign_mcp');
  if(existsSync(manifest.skill.path)) {
    if(ownedSkill(tree(manifest.skill.path),manifest.skill.files)) {
      for(const name of Object.keys(manifest.skill.files))if(existsSync(join(manifest.skill.path,name)))unlinkSync(join(manifest.skill.path,name));
      const prune=(path:string)=>{for(const name of readdirSync(path)){const child=join(path,name);if(lstatSync(child).isDirectory())prune(child);}if(!readdirSync(path).length)rmdirSync(path);};prune(manifest.skill.path);removed.push('skill');
    }else retained.push('modified_or_foreign_skill');
  }
  if(manifest.autostart&&existsSync(manifest.autostart.path)){if(readFileSync(manifest.autostart.path,'utf8')===manifest.autostart.content){unlinkSync(manifest.autostart.path);removed.push('autostart');}else retained.push('modified_or_foreign_autostart');}
  if(!retained.some(value=>value.startsWith('modified_')))unlinkSync(join(dir,'installation.json'));
  return {removed,retained};
}
