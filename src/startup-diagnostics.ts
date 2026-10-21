import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isolatedEnvironment } from './tunnel-runner.js';
import { ProbeError } from './store.js';

type StartupStage='preflight'|'recovery'|'retry_wait'|'launch'|'readiness'|'finished';
interface StartupEvent {at:string;stage:StartupStage;code:string}
export interface StartupDiagnostic {schema:1;owner:'codex-dots-bridge-startup';mode:'manual'|'autostart';outcome:'running'|'starting'|'failed';events:StartupEvent[]}
export function startupErrorCode(error:unknown):string {
  return error instanceof ProbeError&&/^[a-z][a-z0-9_]{0,119}$/.test(error.code)?error.code:'startup_operation_failed';
}
export function startupDiagnosticPath(dir:string) {return resolve(dir)+'.startup.json';}
function readRuntimeStartupFailure(dir:string,now=Date.now()):{at:string;code:string}|undefined {
  try {
    const path=startupDiagnosticPath(dir);
    for(let cursor=path;;cursor=dirname(cursor)) {
      if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())return;
      if(cursor===dirname(cursor))break;
    }
    const info=lstatSync(path);if(!info.isFile()||info.nlink!==1||info.size>65536)return;
    const value=JSON.parse(readFileSync(path,'utf8')) as StartupDiagnostic;
    if(value.schema!==1||value.owner!=='codex-dots-bridge-startup'||value.outcome!=='failed'||!Array.isArray(value.events))return;
    const event=value.events.at(-1);
    if(!event||event.stage!=='finished'||typeof event.code!=='string'||!/^[a-z][a-z0-9_]{0,79}$/.test(event.code)||typeof event.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at))return;
    const at=Date.parse(event.at);if(!Number.isFinite(at)||at>now+2000||now-at>86400_000)return;
    // A new owner/state must make an older attempt irrelevant. This is only a
    // labelled recent record, never a substitute for current authenticated state.
    for(const name of ['supervisor-state.json','supervisor.lock','service.lock']) {
      const metadata=join(dir,name);if(!existsSync(metadata))continue;
      const current=lstatSync(metadata);if(!current.isFile()||current.isSymbolicLink()||current.mtimeMs>at+2)return;
    }
    return {at:event.at,code:event.code};
  }catch {return;}
}

export function readRecentStartupFailure(dir:string,now=Date.now()):{at:string;code:string}|undefined {
  const runtime=readRuntimeStartupFailure(dir,now);if(runtime)return runtime;
  try{
    const config=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));
    const root=resolve(config.installation.root),installation=dirname(dirname(root));
    if(dirname(root)!==join(installation,'payload'))return;
    const path=join(installation,'.launcher-diagnostics.json');
    for(let cursor=path;;cursor=dirname(cursor)){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())return;if(cursor===dirname(cursor))break;}
    const info=lstatSync(path);if(!info.isFile()||info.nlink!==1||info.size>65536)return;
    const value=JSON.parse(readFileSync(path,'utf8'));
    if(value.schema!==1||value.owner!=='codex-dots-bridge-launcher'||value.outcome!=='failed'||typeof value.code!=='string'||!/^[a-z][a-z0-9_]{0,79}$/.test(value.code)||typeof value.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at))return;
    const at=Date.parse(value.at);if(!Number.isFinite(at)||at>now+2000||now-at>86400_000)return;
    for(const name of ['supervisor-state.json','supervisor.lock','service.lock']){const p=join(dir,name);if(existsSync(p)&&lstatSync(p).mtimeMs>at+2)return;}
    return {at:value.at,code:value.code};
  }catch{return;}
}

// This sibling is deliberately outside the old runtime's strictly owned data
// directory. A diagnostic failure must never change startup's business result.
const windowsWrite=String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$path=[Environment]::GetEnvironmentVariable('CODEX_DOTS_STARTUP_PATH')
$temp=[Environment]::GetEnvironmentVariable('CODEX_DOTS_STARTUP_TEMP')
$text=[Console]::In.ReadToEnd()
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowed=@($user.Value,$system.Value)
function Assert-Path([string]$value) {
  for($cursor=$value;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
    if(([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) -and (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'unsafe_path'}
  }
}
function Assert-Target {
  Assert-Path $path
  if([IO.Directory]::GetAccessControl([IO.Path]::GetDirectoryName($path)).GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'untrusted_owner'}
  if([IO.Directory]::Exists($path)){throw 'unsafe_file'}
  if([IO.File]::Exists($path)) {
    if(([IO.FileInfo]::new($path)).Length -gt 65536){throw 'unsafe_file'}
    if([IO.File]::GetAccessControl($path).GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'untrusted_owner'}
    $old=[IO.File]::ReadAllText($path)|ConvertFrom-Json
    if($old.schema -ne 1 -or $old.owner -cne 'codex-dots-bridge-startup'){throw 'foreign_file'}
  }
}
$created=$false
try {
  Assert-Target;Assert-Path $temp
  $stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $created=$true
  try {
    $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetAccessRuleProtection($true,$false)
    foreach($identity in @($user,$system)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))}
    [IO.File]::SetAccessControl($temp,$acl)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($text);$stream.Write($bytes,0,$bytes.Length)
  }finally{$stream.Dispose()}
  Assert-Target
  if([IO.File]::Exists($path)){[IO.File]::Replace($temp,$path,[NullString]::Value)}else{[IO.File]::Move($temp,$path)}
}finally{if($created -and [IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
`;
export function writeStartupDiagnostic(dir:string,diagnostic:StartupDiagnostic):void {
  const path=startupDiagnosticPath(dir),temp=path+'.'+randomUUID()+'.tmp';
  try {
    if(process.platform==='win32') {
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsWrite,'utf16le').toString('base64')],{
        input:JSON.stringify(diagnostic)+'\n',env:{...isolatedEnvironment(),CODEX_DOTS_STARTUP_PATH:path,CODEX_DOTS_STARTUP_TEMP:temp},
        windowsHide:true,stdio:['pipe','ignore','ignore'],timeout:5000,
      });
      return;
    }
    for(let cursor=path;;cursor=dirname(cursor)) {
      if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())return;
      if(cursor===dirname(cursor))break;
    }
    if(existsSync(path)) {
      const info=lstatSync(path);
      if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||info.size>65536)return;
      const previous=JSON.parse(readFileSync(path,'utf8'));
      if(previous.schema!==1||previous.owner!=='codex-dots-bridge-startup')return;
    }
    writeFileSync(temp,JSON.stringify(diagnostic)+'\n',{flag:'wx',mode:0o600});renameSync(temp,path);
  }catch {/* Best-effort diagnostics never mask or retry the startup result. */}
  finally {if(process.platform!=='win32'&&existsSync(temp))try{unlinkSync(temp);}catch{/* retain only our failed temporary */}}
}

export function createStartupDiagnostic(autostart:boolean) {
  const diagnostic:StartupDiagnostic={schema:1,owner:'codex-dots-bridge-startup',mode:autostart?'autostart':'manual',outcome:'failed',events:[]};
  return {diagnostic,record(stage:StartupStage,code:string) {
    diagnostic.events.push({at:new Date().toISOString(),stage,code:/^[a-z][a-z0-9_]{0,119}$/.test(code)?code:'startup_operation_failed'});
  }};
}
