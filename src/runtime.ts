import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { ProbeError } from './store.js';

export const defaultDataDir=()=>join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'CodexDotsBridge','p0');
const configSchema=z.object({owner:z.literal('codex-dots-bridge-p0'),instance_id:z.string().uuid(),endpoint:z.string().optional()}).strict();
export type ProbeConfig=z.infer<typeof configSchema>;
const ownedFiles=new Set(['config.json','caller.key','worker.key','probe.sqlite','probe.sqlite-wal','probe.sqlite-shm','service.lock']);
// Static script: the path is passed as environment data, never interpolated into PowerShell code.
const windowsPrivateAcl=String.raw`
$ErrorActionPreference='Stop'
$directory=[Environment]::GetEnvironmentVariable('CODEX_DOTS_ACL_DIRECTORY')
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$identities=@($user,$system)
$allow=[System.Security.AccessControl.AccessControlType]::Allow
$full=[System.Security.AccessControl.FileSystemRights]::FullControl
$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$none=[System.Security.AccessControl.PropagationFlags]::None
$allowedOwners=@($user.Value,$system.Value)
function Assert-PrivateOwner($security) {
  if($security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $allowedOwners) {exit 42}
}
# Preflight every existing owned object before any ACL mutation, including inheritance propagation.
Assert-PrivateOwner ([System.IO.Directory]::GetAccessControl($directory))
$secrets=[System.IO.Path]::Combine($directory,'secrets')
if([System.IO.Directory]::Exists($secrets)) {
  Assert-PrivateOwner ([System.IO.Directory]::GetAccessControl($secrets))
  foreach($secretFile in [System.IO.Directory]::GetFiles($secrets)) {Assert-PrivateOwner ([System.IO.File]::GetAccessControl($secretFile))}
}
$files=@()
foreach($name in [Environment]::GetEnvironmentVariable('CODEX_DOTS_ACL_FILES').Split('|')) {
  $file=[System.IO.Path]::Combine($directory,$name)
  if([System.IO.File]::Exists($file)) {
    if(([System.IO.File]::GetAttributes($file) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'reparse_data_file'}
    Assert-PrivateOwner ([System.IO.File]::GetAccessControl($file))
    $files+=$file
  }
}
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach($identity in $identities) {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity,$full,$inherit,$none,$allow))
}
[System.IO.Directory]::SetAccessControl($directory,$acl)
function Assert-PrivateAcl($security,$isDirectory) {
  Assert-PrivateOwner $security
  if(-not $security.AreAccessRulesProtected) {throw 'unprotected_acl'}
  $rules=@($security.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
  if($rules.Count -ne 2) {throw 'unexpected_acl_rules'}
  foreach($identity in $identities) {
    $matches=@($rules | Where-Object {$_.IdentityReference.Value -eq $identity.Value})
    if($matches.Count -ne 1) {throw 'missing_private_acl'}
    $rule=$matches[0]
    if($rule.AccessControlType -ne $allow -or $rule.FileSystemRights -ne $full -or $rule.IsInherited) {throw 'invalid_private_acl'}
    if($isDirectory -and ($rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne $none)) {throw 'invalid_acl_inheritance'}
  }
}
Assert-PrivateAcl ([System.IO.Directory]::GetAccessControl($directory)) $true
foreach($file in $files) {
    if(([System.IO.File]::GetAttributes($file) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'reparse_data_file'}
    Assert-PrivateOwner ([System.IO.File]::GetAccessControl($file))
    $fileAcl=[System.Security.AccessControl.FileSecurity]::new()
    $fileAcl.SetAccessRuleProtection($true,$false)
    foreach($identity in $identities) {
      $fileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity,$full,$allow))
    }
    [System.IO.File]::SetAccessControl($file,$fileAcl)
    Assert-PrivateAcl ([System.IO.File]::GetAccessControl($file)) $false
}
`;
function protectWindowsDirectory(directory:string, allowedFiles=ownedFiles, allowSecrets=false) {
  // Unknown materials cannot be affected by inherited ACL propagation or an explicit reset.
  for(const name of readdirSync(directory)) {
    const entry=lstatSync(join(directory,name));
    if(entry.isSymbolicLink()) throw new ProbeError(name.endsWith('.key')?'symlink_credential':'symlink_data_file');
    if(allowSecrets && name==='secrets' && entry.isDirectory()) continue;
    if(!allowedFiles.has(name)) throw new ProbeError('unexpected_data_directory_entry');
    if(!entry.isFile()) throw new ProbeError('invalid_data_file');
  }
  try {
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsPrivateAcl,'utf16le').toString('base64')],{
      env:{...process.env,CODEX_DOTS_ACL_DIRECTORY:directory,CODEX_DOTS_ACL_FILES:[...allowedFiles].join('|')},stdio:'pipe',windowsHide:true,timeout:30_000,
    });
  } catch(error) {
    // The static PowerShell preflight uses 42 solely for an owner outside the allowed identities.
    if((error as {status?:number}).status===42) throw new ProbeError('untrusted_data_owner');
    throw new ProbeError('private_directory_protection_failed');
  }
}
export function privateDirectory(dataDir:string) {
  const full=resolve(dataDir);
  // Never create secret-bearing state under a symlink/junction.
  for(let cursor=full;;cursor=dirname(cursor)) {
    if(existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new ProbeError('symlink_data_directory');
    if(dirname(cursor)===cursor) break;
  }
  // ACL changes are limited to a new/empty directory or one with a validated bridge owner.
  if(existsSync(full) && readdirSync(full).length>0) {
    const config=join(full,'config.json');
    if(!existsSync(config) || lstatSync(config).isSymbolicLink()) throw new ProbeError('unowned_data_directory');
    readConfig(full);
  }
  mkdirSync(full,{recursive:true,mode:0o700});
  if(process.platform==='win32') protectWindowsDirectory(full);
  return full;
}
export function writeConfig(dir:string, config:ProbeConfig) {
  const temp=join(dir,`config.${randomUUID()}.tmp`);
  writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
  renameSync(temp,join(dir,'config.json'));
}
export function readConfig(dir:string):ProbeConfig {
  const config=configSchema.parse(JSON.parse(readFileSync(join(dir,'config.json'),'utf8')));
  if(config.endpoint) {
    const url=new URL(config.endpoint);
    if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || !url.port || url.pathname!=='/' || url.search || url.hash || url.username || url.password) throw new ProbeError('invalid_local_endpoint');
  }
  return config;
}
export function init(dir:string) {
  const full=privateDirectory(dir);
  if(readdirSync(full).length>0) {
    const existing=readConfig(full); readToken(full,'caller'); readToken(full,'worker'); return existing;
  }
  for(const role of ['caller','worker']) writeFileSync(join(full,`${role}.key`),randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  const config:ProbeConfig={owner:'codex-dots-bridge-p0',instance_id:randomUUID()};
  writeConfig(full,config);
  if(process.platform==='win32') protectWindowsDirectory(full);
  return config;
}
export function readToken(dir:string,role:'caller'|'worker') {
  const path=join(dir,`${role}.key`);
  if(lstatSync(path).isSymbolicLink()) throw new ProbeError('symlink_credential');
  const token=readFileSync(path,'utf8').trim();
  if(!/^[a-f0-9]{64}$/.test(token)) throw new ProbeError('invalid_local_credential');
  return token;
}
export function acquireLock(dir:string) {
  const path=join(dir,'service.lock');
  const owner=randomUUID();
  const value=JSON.stringify({owner,pid:process.pid});
  const acquire=()=>writeFileSync(path,value,{flag:'wx',mode:0o600});
  try {acquire();} catch(e) {
    if((e as NodeJS.ErrnoException).code!=='EEXIST') throw e;
    let old:{pid:number;owner:string};
    try {old=JSON.parse(readFileSync(path,'utf8'));} catch {throw new ProbeError('invalid_service_lock');}
    if(!Number.isInteger(old.pid) || old.pid<=0) throw new ProbeError('invalid_service_lock');
    try {process.kill(old.pid,0); throw new ProbeError('service_already_running');}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH') throw new ProbeError('service_already_running');}
    // P0 fails closed. Automatic stale-file deletion has a compare/unlink race.
    // Recover this owned lock manually after checking the original process.
    throw new ProbeError('stale_service_lock');
  }
  return ()=>{try {if(readFileSync(path,'utf8')===value) unlinkSync(path);} catch {/* another owner must not be removed */}};
}

export const defaultProductionDataDir=()=>join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'CodexDotsBridge','data');
const productionSchema=z.object({
  owner:z.literal('codex-dots-bridge'),schema_version:z.literal(1),instance_id:z.string().uuid(),endpoint:z.string().optional(),
  tunnel:z.object({tunnel_id:z.string().regex(/^tunnel_[A-Za-z0-9_-]+$/),organization_id:z.string().min(1),client_path:z.string().min(1),key_file:z.string().min(1)}).strict().optional(),
  installation:z.object({root:z.string(),node_path:z.string()}).strict().optional(),
  plugin:z.object({subscription_verified_at:z.string().datetime().optional()}).strict().optional(),
}).strict();
export type ProductionConfig=z.infer<typeof productionSchema>;
const productionFiles=new Set(['config.json','caller.key','worker.key','tasks.sqlite','tasks.sqlite-wal','tasks.sqlite-shm','service.lock','supervisor.lock','supervisor-state.json','supervisor.stop','tunnel-health.url','installation.json','backup-manifest.json','tunnel-runtime.env']);
const productionTempName=/^(?:supervisor-state|config)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
export function readProductionConfig(dir:string):ProductionConfig {
  const config=productionSchema.parse(JSON.parse(readFileSync(join(dir,'config.json'),'utf8')));
  if(config.endpoint) {
    const u=new URL(config.endpoint);
    if(u.protocol!=='http:' || u.hostname!=='127.0.0.1' || !u.port || u.pathname!=='/' || u.search || u.hash || u.username || u.password) throw new ProbeError('invalid_local_endpoint');
  }
  return config;
}
export function writeProductionConfig(dir:string,config:ProductionConfig) {
  productionSchema.parse(config);
  const temp=join(dir,`config.${randomUUID()}.tmp`);
  writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
  renameSync(temp,join(dir,'config.json'));
}
export function protectProductionDirectory(dir:string) {
  const full=resolve(dir);
  for(let p=full;;p=dirname(p)) {
    if(existsSync(p) && lstatSync(p).isSymbolicLink()) throw new ProbeError('symlink_data_directory');
    if(p===dirname(p)) break;
  }
  if(existsSync(full) && readdirSync(full).length) {
    const path=join(full,'config.json');
    if(!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new ProbeError('unowned_data_directory');
    readProductionConfig(full);
  }
  mkdirSync(full,{recursive:true,mode:0o700});
  for(const name of readdirSync(full)) {
    const info=lstatSync(join(full,name));
    if(info.isSymbolicLink()) throw new ProbeError('symlink_data_file');
    if(name==='secrets' && info.isDirectory()) {
      for(const child of readdirSync(join(full,name))) if(child!=='tunnel.env' || !lstatSync(join(full,name,child)).isFile() || lstatSync(join(full,name,child)).isSymbolicLink()) throw new ProbeError('unexpected_data_directory_entry');
    } else if((!productionFiles.has(name)&&!productionTempName.test(name)) || !info.isFile()) throw new ProbeError('unexpected_data_directory_entry');
  }
  if(process.platform==='win32') {
    // Validate both directories before ACL propagation from the parent.
    const secrets=join(full,'secrets');
    const allowedFiles=new Set([...productionFiles,...readdirSync(full).filter(name=>productionTempName.test(name))]);
    protectWindowsDirectory(full,allowedFiles,true);
    if(existsSync(secrets)) protectWindowsDirectory(secrets,new Set(['tunnel.env']));
  }
  return full;
}
export function initProduction(dir:string):ProductionConfig {
  const full=protectProductionDirectory(dir);
  if(readdirSync(full).length) {
    const config=readProductionConfig(full);readToken(full,'caller');readToken(full,'worker');return config;
  }
  for(const role of ['caller','worker']) writeFileSync(join(full,`${role}.key`),randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  const config:ProductionConfig={owner:'codex-dots-bridge',schema_version:1,instance_id:randomUUID()};
  writeProductionConfig(full,config);protectProductionDirectory(full);return config;
}
