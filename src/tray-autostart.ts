import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, lstatSync, openSync, closeSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAutostartEntry, readInstall, safePath } from './maintenance.js';
import { protectProductionDirectory, readProductionConfig } from './runtime.js';
import { ProbeError } from './store.js';

export type AutostartState='enabled'|'disabled'|'unknown';
function startupPath() {
  if(process.platform!=='win32'||!process.env.APPDATA)throw new ProbeError('autostart_windows_only');
  return join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup','CodexDotsBridge.vbs');
}
function fileText(path:string):string|undefined {
  safePath(path);
  if(!existsSync(path))return;
  if(!lstatSync(path).isFile())throw new ProbeError('unsafe_autostart_file');
  return readFileSync(path,'utf8');
}
function ownedSettings(dir:string) {
  safePath(dir);safePath(join(dir,'config.json'));safePath(join(dir,'installation.json'));
  const config=readProductionConfig(dir),manifest=readInstall(dir);
  if(!manifest)throw new ProbeError('installation_manifest_missing');
  const root=dirname(dirname(resolve(manifest.mcp.args[0]!)));
  if(config.installation&&(resolve(config.installation.root)!==root||resolve(config.installation.node_path)!==resolve(manifest.mcp.command)))throw new ProbeError('installation_binding_mismatch');
  return manifest;
}
function inspect(dir:string) {
  const manifest=ownedSettings(dir),path=startupPath(),content=fileText(path);
  if(content!==undefined&&(!manifest.autostart||manifest.autostart.path!==path||manifest.autostart.content!==content))throw new ProbeError('foreign_autostart_collision');
  return {manifest,path,content,state:content===undefined?'disabled' as const:'enabled' as const};
}
export function readTrayAutostart(dir:string):AutostartState {
  try{return inspect(dir).state;}catch{return 'unknown';}
}
// A dedicated Startup lock coordinates tray clients without changing running-service locks.
// Existing/stale locks fail closed; a tray never removes another process's lock.
export function setTrayAutostart(dir:string,enabled:boolean):{schema:1;autostart:'enabled'|'disabled';verified:true} {
  protectProductionDirectory(dir);
  const path=startupPath();safePath(path);mkdirSync(dirname(path),{recursive:true});
  const lockPath=join(dirname(path),'.CodexDotsBridge.autostart.lock');safePath(lockPath);
  let fd:number;
  try{fd=openSync(lockPath,'wx',0o600);}catch{throw new ProbeError('autostart_update_busy');}
  let originalManifest:string|undefined,originalStartup:string|undefined,updatedManifest:string|undefined,newStartup:string|undefined;
  let manifestWritten=false,startupWritten=false;
  const manifestPath=join(dir,'installation.json'),temp=join(dir,`config.${randomUUID()}.tmp`);
  const lockOwner=randomUUID();
  try {
    writeFileSync(fd,lockOwner);
    const current=inspect(dir);originalManifest=fileText(manifestPath);originalStartup=current.content;
    const next={...current.manifest};
    if(enabled) {
      next.autostart=createAutostartEntry(dir,current.manifest.mcp,true);
      newStartup=next.autostart.content;
    }else delete next.autostart;
    updatedManifest=JSON.stringify(next,null,2)+'\n';
    if(fileText(manifestPath)!==originalManifest||fileText(path)!==originalStartup)throw new ProbeError('autostart_settings_changed');
    // Remove only exact owned content; exclusive creation never overwrites a new foreign entry.
    if(originalStartup!==undefined&&originalStartup!==newStartup){unlinkSync(path);startupWritten=true;}
    if(newStartup!==undefined&&originalStartup!==newStartup){writeFileSync(path,newStartup,{flag:'wx',mode:0o600});startupWritten=true;}
    if(fileText(manifestPath)!==originalManifest)throw new ProbeError('autostart_settings_changed');
    writeFileSync(temp,updatedManifest,{flag:'wx',mode:0o600});renameSync(temp,manifestPath);manifestWritten=true;
    protectProductionDirectory(dir);
    if(fileText(manifestPath)!==updatedManifest||fileText(path)!==newStartup||readTrayAutostart(dir)!==(enabled?'enabled':'disabled'))throw new ProbeError('autostart_readback_failed');
    return {schema:1,autostart:enabled?'enabled':'disabled',verified:true};
  }catch(error) {
    let rollbackFailed=false;
    try {
      if(manifestWritten) {
        if(fileText(manifestPath)===updatedManifest&&originalManifest!==undefined)writeFileSync(manifestPath,originalManifest,{mode:0o600});
        else rollbackFailed=true;
      }
      if(startupWritten) {
        const actual=fileText(path);
        if(actual===newStartup) {
          if(actual!==undefined)unlinkSync(path);
          if(originalStartup!==undefined)writeFileSync(path,originalStartup,{flag:'wx',mode:0o600});
        }else if(actual===undefined&&originalStartup!==undefined)writeFileSync(path,originalStartup,{flag:'wx',mode:0o600});
        else rollbackFailed=true;
      }
    }catch{rollbackFailed=true;}
    if(rollbackFailed)throw new ProbeError('autostart_rollback_incomplete');
    throw error instanceof ProbeError?error:new ProbeError('autostart_update_failed');
  }finally {
    if(existsSync(temp))try{unlinkSync(temp);}catch{/* preserve a failed temporary write for inspection */}
    closeSync(fd);
    try{if(fileText(lockPath)===lockOwner)unlinkSync(lockPath);}catch{/* never remove an unverified lock */}
  }
}
