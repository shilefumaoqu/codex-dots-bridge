import { closeSync, existsSync, openSync, readSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, copyFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { type AutostartEntry, type LinkAutostart, startupPath, validateLauncher, inspectStartupLink, prepareStartupLink, verifyAutostart } from './startup-link.js';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initProduction, readProductionConfig, readOwnerNotificationConfig, writeProductionConfig, protectProductionDirectory } from './runtime.js';
import { ProbeError } from './store.js';
import { tunnelHealthSnapshot, type TunnelConnectionDiagnostic } from './tunnel-diagnostics.js';
import { inspectMaintenanceActivity, validateMaintenanceConfiguration } from './storage-migration.js';

const digest=(path:string)=>{
  const hash=createHash('sha256'),fd=openSync(path,'r'),chunk=Buffer.allocUnsafe(1024*1024);
  try {let bytes:number;while((bytes=readSync(fd,chunk,0,chunk.length,null))>0)hash.update(chunk.subarray(0,bytes));return hash.digest('hex');}
  finally {closeSync(fd);}
};
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
  let activity={tasks:0,desktop_sends:0,desktop_reads:0,desktop_echo:0,context_reads:0,total:0};
  const dbPath=join(dir,'tasks.sqlite');
  if(existsSync(dbPath)) {
    regular(dbPath);const db=new Database(dbPath,{readonly:true,fileMustExist:true});
    try {
      const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(t=>t.name);
      if(tables.includes('tasks')) {
        const indexed=(db.pragma('table_xinfo(tasks)') as {name:string}[]).some(column=>column.name==='status');
        const status=indexed?'status':"json_extract(data,'$.status')";
        for(const row of db.prepare(`SELECT ${status} AS status,COUNT(*) AS count FROM tasks GROUP BY ${status}`).all() as {status:string;count:number}[]) counts[row.status]=row.count;
      }
      if(tables.includes('task_subscriptions')) subscriptions=(db.prepare("SELECT COUNT(*) AS n FROM task_subscriptions WHERE json_extract(data,'$.active')=1 AND json_extract(data,'$.expires_at')>?").get(Date.now()) as {n:number}).n;
      activity=inspectMaintenanceActivity(db);
    } finally {db.close();}
  }
  return {instance_id:config.instance_id,service:service?(processIsAlive(service.pid)?'running':'stale_lock'):'stopped',endpoint:config.endpoint??null,tunnel_configured:!!config.tunnel,plugin_subscription:subscriptions?'active':'missing_or_expired',tasks:counts,maintenance_activity:activity,storage:config.schema_version===2?config.storage:{database_version:1,phase:'ready'},codex_tools:'requires_real_call_after_restart',task_bodies:'redacted'};
}
export async function connectionDiagnosticsData(dir:string) {
  const config=readProductionConfig(dir);
  const unknown:TunnelConnectionDiagnostic={tunnel_connection:'unknown',tunnel_connection_reason:'health_unavailable',tunnel_checked_at:new Date().toISOString()};
  if(!config.tunnel) return {tunnel_configured:false,tunnel_health:'not_configured' as const,...unknown,tunnel_connection_reason:'not_configured' as const};
  if(existsSync(join(dir,'tunnel-health.url'))) {
    const u=new URL(readFileSync(join(dir,'tunnel-health.url'),'utf8').trim());
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/') throw new ProbeError('invalid_tunnel_health_endpoint');
    return {tunnel_configured:true,...await tunnelHealthSnapshot(u)};
  }
  return {tunnel_configured:true,tunnel_health:'unknown' as const,...unknown};
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
interface BackupManifest {owner:'codex-dots-bridge-backup';schema_version:1|2;instance_id:string;files:Record<string,string>}
function pathsOverlap(a:string,b:string) {
  const key=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
  const left=key(a),right=key(b);
  return left===right||left.startsWith(right+sep)||right.startsWith(left+sep);
}
export async function backupData(dir:string,destination:string) {
  protectProductionDirectory(dir);const config=readProductionConfig(dir),target=resolve(destination);
  if(pathsOverlap(dir,target))throw new ProbeError('backup_path_conflict');
  if(existsSync(target)&&readdirSync(target).length)throw new ProbeError('backup_destination_not_empty');
  validateMaintenanceConfiguration(dir);
  initProduction(target);
  const files=['config.json','caller.key','worker.key'];
  for(const name of ['caller.key','worker.key'])copyFileSync(join(dir,name),join(target,name));
  for(const name of ['desktop-conversations.json','desktop-echo.json','storage-migration.json'])if(existsSync(join(dir,name))) {
    copyFileSync(join(dir,name),join(target,name));files.push(name);
  }
  if(existsSync(join(dir,'owner-notification.json'))) {
    readOwnerNotificationConfig(dir); // Validate only; never import executable code.
    copyFileSync(join(dir,'owner-notification.json'),join(target,'owner-notification.json'));
    files.push('owner-notification.json');
  }
  if(existsSync(join(dir,'tasks.sqlite'))) {
    const db=new Database(join(dir,'tasks.sqlite'),{readonly:true,fileMustExist:true});
    try {await db.backup(join(target,'tasks.sqlite'));}finally{db.close();}files.push('tasks.sqlite');
    const check=new Database(join(target,'tasks.sqlite'),{readonly:true,fileMustExist:true});
    try {if(check.pragma('quick_check',{simple:true})!=='ok')throw new ProbeError('backup_database_integrity_failed');}finally{check.close();}
  }
  const {endpoint:_endpoint,installation:_installation,...saved}=config;
  if(saved.tunnel) {
    regular(saved.tunnel.key_file);copyFileSync(saved.tunnel.key_file,join(target,'tunnel-runtime.env'));
    saved.tunnel={...saved.tunnel,key_file:join(target,'tunnel-runtime.env')};files.push('tunnel-runtime.env');
  }
  writeProductionConfig(target,saved);
  const manifest:BackupManifest={owner:'codex-dots-bridge-backup',schema_version:2,instance_id:config.instance_id,files:Object.fromEntries(files.map(name=>[name,digest(join(target,name))]))};
  writeFileSync(join(target,'backup-manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});protectProductionDirectory(target);
  return {backup_directory:target,consistent_sqlite:true,recovery_credentials_included:!!saved.tunnel,contains_secrets:true};
}
export function restoreData(backup:string,targetDir:string) {
  const source=resolve(backup),target=resolve(targetDir);
  if(pathsOverlap(source,target))throw new ProbeError('restore_path_conflict');
  assertStopped(target);
  protectProductionDirectory(source);
  const manifest=JSON.parse(readFileSync(join(source,'backup-manifest.json'),'utf8')) as BackupManifest;
  if(manifest.owner!=='codex-dots-bridge-backup'||![1,2].includes(manifest.schema_version))throw new ProbeError('invalid_backup_manifest');
  const allowed=new Set(['config.json','owner-notification.json','desktop-conversations.json','desktop-echo.json','storage-migration.json','caller.key','worker.key','tasks.sqlite','tunnel-runtime.env']);
  if(!manifest.files['config.json']||!manifest.files['caller.key']||!manifest.files['worker.key'])throw new ProbeError('incomplete_backup');
  for(const [name,sum] of Object.entries(manifest.files)) {if(!allowed.has(name))throw new ProbeError('invalid_backup_entry');regular(join(source,name));if(digest(join(source,name))!==sum)throw new ProbeError('backup_integrity_failed');}
  const config=readProductionConfig(source);if(config.instance_id!==manifest.instance_id)throw new ProbeError('backup_instance_mismatch');
  if(config.tunnel&&!manifest.files['tunnel-runtime.env'])throw new ProbeError('backup_key_missing');
  const notificationConfig=manifest.files['owner-notification.json']?readOwnerNotificationConfig(source):undefined;
  validateMaintenanceConfiguration(source);
  if(existsSync(target)&&readdirSync(target).length)throw new ProbeError('restore_destination_not_empty');
  initProduction(target);
  for(const name of Object.keys(manifest.files))if(name!=='config.json')copyFileSync(join(source,name),join(target,name));
  if(config.tunnel)config.tunnel={...config.tunnel,key_file:join(target,'tunnel-runtime.env')};
  delete config.endpoint;delete config.installation;
  // Restored adapters refer to local executable code and an external account config.
  // Preserve the reference as disabled; restoring data never activates it.
  if(notificationConfig) writeFileSync(join(target,'owner-notification.json'),JSON.stringify({...notificationConfig,enabled:false},null,2)+'\n',{mode:0o600});
  writeProductionConfig(target,config);protectProductionDirectory(target);
  return {restored_directory:target,instance_id:config.instance_id,mcp_registration:'run_setup_again',dot_binding:'verify_subscription_after_start'};
}
export interface InstallOptions {nodePath:string;entryPath:string;skillSource:string;codexHome?:string;codexCommand?:string;autostart?:boolean;upgrade?:boolean;startupLauncher?:string;preparedAutostart?:string;preserveAutostart?:boolean}
export interface InstallManifest {owner:'codex-dots-bridge';instance_id:string;codex_home:string;codex_command:string;mcp:{name:string;command:string;args:string[]};mcp_registration?:unknown;skill:{path:string;files:Record<string,string>};autostart?:AutostartEntry;autostart_launcher?:string}
export function safePath(path:string) {
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
export function readInstall(dir:string):InstallManifest|undefined {
  const path=join(dir,'installation.json');if(!existsSync(path))return;
  regular(path);const value=JSON.parse(readFileSync(path,'utf8')) as InstallManifest;
  if(value.owner!=='codex-dots-bridge'||value.instance_id!==readProductionConfig(dir).instance_id)throw new ProbeError('foreign_installation_manifest');
  if(value.mcp.name!=='codex-dots-bridge'||value.skill.path!==join(value.codex_home,'skills','codex-dots-bridge')||value.mcp.args.length!==4||value.mcp.args[1]!=='stdio'||value.mcp.args[2]!=='--data-dir'||value.mcp.args[3]!==resolve(dir))throw new ProbeError('invalid_installation_manifest');
  safePath(value.skill.path);
  for(const name of Object.keys(value.skill.files)) {const path=resolve(value.skill.path,name);if(!path.startsWith(resolve(value.skill.path)+sep))throw new ProbeError('invalid_installation_manifest');}
  if(value.autostart_launcher)validateLauncher(value.mcp.args[0]!,value.autostart_launcher);
  if(value.autostart){
    if(value.autostart.kind==='startup-link'){
      if(value.autostart.path!==startupPath()||value.autostart.launcher!==value.autostart_launcher)throw new ProbeError('invalid_installation_manifest');
    }else if(value.autostart.kind!==undefined&&value.autostart.kind!=='legacy-vbs'||value.autostart.path!==startupPath('legacy'))throw new ProbeError('invalid_installation_manifest');
  }
  return value;
}
export function createAutostartEntry(dir:string,mcp:InstallManifest['mcp'],requireTray=false) {
  if(process.platform!=='win32'||!process.env.APPDATA)throw new ProbeError('autostart_windows_only');
  const path=join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup','CodexDotsBridge.vbs');
  const tray=join(dirname(dirname(resolve(mcp.args[0]!))),'CodexDotsBridge.Tray.exe');
  safePath(tray);
  if(requireTray&&!existsSync(tray))throw new ProbeError('tray_executable_missing');
  if(existsSync(tray))regular(tray);
  const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
  const command=(args:string[])=>{if(args.some(arg=>/["%\r\n\0]/.test(arg)))throw new ProbeError('unsafe_autostart_argument');return args.map(v=>'"'+v+'"').join(' ');};
  const launch=command([mcp.command,mcp.args[0]!,'run','--autostart','--data-dir',resolve(dir)]);
  const content='Set shell = CreateObject("WScript.Shell")\r\nshell.Run '+quote(launch)+', 0, False\r\n'+
    (existsSync(tray)?'shell.Run '+quote(command([tray,'--data-dir',resolve(dir),'--background']))+', 0, False\r\n':'');
  return {path,content};
}
export function installCodex(dir:string,options:InstallOptions) {
  protectProductionDirectory(dir);const config=readProductionConfig(dir),previous=readInstall(dir);
  const home=resolve(options.codexHome??process.env.CODEX_HOME??join(homedir(),'.codex')),command=options.codexCommand??findCodexCommand();
  safePath(home);safePath(join(home,'skills','codex-dots-bridge'));safePath(options.skillSource);
  const mcp={name:'codex-dots-bridge',command:resolve(options.nodePath),args:[resolve(options.entryPath),'stdio','--data-dir',resolve(dir)]};
  regular(mcp.command);regular(mcp.args[0]!);const skillFiles=tree(resolve(options.skillSource)),skillPath=join(home,'skills','codex-dots-bridge');
  if(!skillFiles['SKILL.md'])throw new ProbeError('skill_source_missing');
  const changingRegistration=!!previous&&(previous.codex_command!==command||JSON.stringify(previous.mcp)!==JSON.stringify(mcp));
  if(previous&&(previous.codex_home!==home||(!options.upgrade&&changingRegistration)))throw new ProbeError('installation_change_requires_uninstall');
  mkdirSync(home,{recursive:true}); // The official CLI requires CODEX_HOME to exist on first installation.
  const existing=mcpEntry(command,home,mcp.name);
  if(existing&&(!previous||!entryMatches(existing,previous.mcp,previous.mcp_registration)))throw new ProbeError('foreign_mcp_collision');
  if(existsSync(skillPath)&&(!previous||!ownedSkill(tree(skillPath),previous.skill.files)))throw new ProbeError('foreign_or_modified_skill_collision');
  if(previous&&!options.upgrade&&JSON.stringify(skillFiles)!==JSON.stringify(previous.skill.files))throw new ProbeError('skill_upgrade_requires_uninstall');
  if(previous?.autostart)verifyAutostart(previous.autostart);
  const launcher=options.startupLauncher?validateLauncher(mcp.args[0]!,options.startupLauncher):previous?.autostart_launcher;
  const manifest:InstallManifest={owner:'codex-dots-bridge',instance_id:config.instance_id,codex_home:home,codex_command:command,mcp,mcp_registration:changingRegistration?undefined:previous?.mcp_registration,skill:{path:skillPath,files:skillFiles},...(launcher?{autostart_launcher:launcher}:{})};
  if(options.preparedAutostart!==undefined) {
    if(!launcher)throw new ProbeError('startup_launcher_missing');
    const actual=inspectStartupLink(launcher);
    if(!actual.exists||!actual.owned||actual.content!==options.preparedAutostart)throw new ProbeError('autostart_preparation_changed');
    manifest.autostart={kind:'startup-link',path:actual.path,content:actual.content,launcher};
  } else if(options.autostart&&launcher&&!options.preserveAutostart){
    const current=inspectStartupLink(launcher);
    // setup/Connect preserves an existing registration, including Windows disabling it.
    // Explicit tray re-enabling still uses prepareStartupLink's approval checks.
    if(previous?.autostart?.kind==='startup-link'&&current.exists&&current.owned&&current.content===previous.autostart.content&&previous.autostart.launcher===launcher)manifest.autostart=previous.autostart;
    else manifest.autostart=prepareStartupLink(launcher,previous?.autostart);
  }
  else if(options.autostart&&!options.preserveAutostart) {
    const {path,content}=createAutostartEntry(dir,mcp);
    manifest.autostart={path,content};
  }else if(previous?.autostart)manifest.autostart=previous.autostart;
  if(manifest.autostart&&manifest.autostart.kind!=='startup-link') {
    safePath(manifest.autostart.path);
    if(existsSync(manifest.autostart.path)) {
      regular(manifest.autostart.path);
      if(!previous?.autostart||previous.autostart.path!==manifest.autostart.path||readFileSync(manifest.autostart.path,'utf8')!==previous.autostart.content)throw new ProbeError('foreign_autostart_collision');
    }
  }
  const desiredAutostart=manifest.autostart;
  const changingAutostart=!!previous?.autostart&&!!desiredAutostart&&desiredAutostart.kind!=='startup-link'&&previous.autostart.content!==desiredAutostart.content;
  // Keep the old Startup ownership recoverable until its replacement is written.
  if(changingAutostart)manifest.autostart=previous!.autostart;
  const previousManifest=previous?readFileSync(join(dir,'installation.json'),'utf8'):undefined;
  const previousSkill=options.upgrade&&previous?Object.fromEntries(Object.keys(existsSync(skillPath)?tree(skillPath):{}).map(name=>[name,readFileSync(join(skillPath,name))])):undefined;
  try{
  // Record intent before registrations so a failed step remains recoverable and owns only exact matching content.
  writeFileSync(join(dir,'installation.json'),JSON.stringify(manifest,null,2),{mode:0o600});protectProductionDirectory(dir);
  if(changingRegistration&&existing)runCodex(command,home,['mcp','remove',mcp.name]);
  if(!existing||changingRegistration)runCodex(command,home,['mcp','add',mcp.name,'--',mcp.command,...mcp.args]);
  const registered=mcpEntry(command,home,mcp.name);
  if(!entryMatches(registered,mcp))throw new ProbeError('mcp_registration_readback_failed');
  manifest.mcp_registration=registered;writeFileSync(join(dir,'installation.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  mkdirSync(skillPath,{recursive:true});
  for(const name of Object.keys(previous?.skill.files??{}))if(!(name in skillFiles)&&existsSync(join(skillPath,name)))unlinkSync(join(skillPath,name));
  for(const name of Object.keys(skillFiles)){const path=join(skillPath,name);mkdirSync(dirname(path),{recursive:true});copyFileSync(join(options.skillSource,name),path);}
  if(desiredAutostart&&desiredAutostart.kind!=='startup-link'&&!options.preserveAutostart) {
    mkdirSync(dirname(desiredAutostart.path),{recursive:true});
    if(changingAutostart) {
      const manifestPath=join(dir,'installation.json'),oldManifest=readFileSync(manifestPath,'utf8');
      const oldStartup=existsSync(desiredAutostart.path)?readFileSync(desiredAutostart.path,'utf8'):undefined;
      try {
        writeFileSync(desiredAutostart.path,desiredAutostart.content);
        manifest.autostart=desiredAutostart;
        writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});
      } catch(error) {
        try {
          if(oldStartup===undefined){if(existsSync(desiredAutostart.path))unlinkSync(desiredAutostart.path);}
          else writeFileSync(desiredAutostart.path,oldStartup);
          writeFileSync(manifestPath,oldManifest,{mode:0o600});
        }catch{throw new ProbeError('autostart_rollback_incomplete');}
        throw error;
      }
    } else if(!existsSync(desiredAutostart.path)||readFileSync(desiredAutostart.path,'utf8')!==desiredAutostart.content)writeFileSync(desiredAutostart.path,desiredAutostart.content,{flag:existsSync(desiredAutostart.path)?'w':'wx'});
  }
  return {mcp:'registered',skill:'installed',autostart:!!manifest.autostart,codex_tools:'pending_restart_or_new_chat_and_real_call'};
  }catch(error){
    if(options.upgrade&&previous&&previousManifest!==undefined&&previousSkill){
      try{
        const actual=mcpEntry(command,home,mcp.name);
        if(actual&&!entryMatches(actual,mcp)&&!entryMatches(actual,previous.mcp,previous.mcp_registration))throw new ProbeError('foreign_mcp_collision');
        if(actual&&entryMatches(actual,mcp)&&!entryMatches(actual,previous.mcp,previous.mcp_registration))runCodex(command,home,['mcp','remove',mcp.name]);
        const remaining=mcpEntry(command,home,mcp.name);
        if(existing&&!remaining)runCodex(command,home,['mcp','add',previous.mcp.name,'--',previous.mcp.command,...previous.mcp.args]);
        const now=existsSync(skillPath)?tree(skillPath):{};
        for(const [name,hash] of Object.entries(now))if(previous.skill.files[name]!==hash&&skillFiles[name]!==hash)throw new ProbeError('foreign_or_modified_skill_collision');
        for(const name of Object.keys(now))if(!(name in previousSkill))unlinkSync(join(skillPath,name));
        for(const [name,bytes] of Object.entries(previousSkill)){mkdirSync(dirname(join(skillPath,name)),{recursive:true});writeFileSync(join(skillPath,name),bytes);}
        const restored={...previous,mcp_registration:existing?mcpEntry(command,home,mcp.name):previous.mcp_registration};
        // The CLI may normalize its registration snapshot; preserve that exact readback.
        writeFileSync(join(dir,'installation.json'),JSON.stringify(restored,null,2),{mode:0o600});
      }catch{throw new ProbeError('registration_rollback_incomplete');}
    }
    throw error;
  }
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
  if(manifest.autostart&&existsSync(manifest.autostart.path)){
    if(manifest.autostart.kind==='startup-link'){
      try{verifyAutostart(manifest.autostart);inspectStartupLink(manifest.autostart.launcher,'disable',manifest.autostart.content);removed.push('autostart');}catch{retained.push('modified_or_foreign_autostart');}
    }else if(readFileSync(manifest.autostart.path,'utf8')===manifest.autostart.content){unlinkSync(manifest.autostart.path);removed.push('autostart');}else retained.push('modified_or_foreign_autostart');
  }
  if(!retained.some(value=>value.startsWith('modified_')))unlinkSync(join(dir,'installation.json'));
  return {removed,retained};
}
