import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RebootRecoveryResult {
  recovered: boolean;
  clearPreviousState: boolean;
  reason: string;
  removed: Array<'service.lock'|'supervisor.lock'>;
  bootUtc?: string;
}

/** Windows-only, bounded prior-boot / proven crashed-owner recovery.
 * No task database, key, or process termination access. */
export async function recoverRebootLocks(dir:string):Promise<RebootRecoveryResult> {
  const preserved=(reason:string):RebootRecoveryResult=>({recovered:false,clearPreviousState:false,removed:[],reason});
  if(process.platform!=='win32')return preserved('unsupported_platform');
  // Fresh installs and clean shutdowns need no Windows boot/process probe.
  if(!existsSync(join(dir,'service.lock'))&&!existsSync(join(dir,'supervisor.lock'))) {
    const statePath=join(dir,'supervisor-state.json');
    if(!existsSync(statePath))return preserved('no_previous_state');
    try {
      if(lstatSync(statePath).isFile()&&!lstatSync(statePath).isSymbolicLink()&&lstatSync(statePath).size<=65536) {
        const state=JSON.parse(readFileSync(statePath,'utf8')) as {cleanup_complete?:unknown};
        if(state.cleanup_complete===true)return preserved('cleanup_complete');
      }
    }catch {return preserved('invalid_previous_state');}
  }
  const script=fileURLToPath(new URL('../scripts/recover-reboot-locks.ps1',import.meta.url));
  return new Promise(resolveResult=>{
    execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-DataDir',resolve(dir)],{
      windowsHide:true,timeout:20_000,maxBuffer:64*1024,
    },(error,stdout)=>{
      if(error)return resolveResult(preserved('recovery_probe_failed'));
      try {
        const result=JSON.parse(stdout.replace(/^\uFEFF/,'').trim()) as RebootRecoveryResult;
        if(typeof result.recovered!=='boolean'||typeof result.clearPreviousState!=='boolean'||typeof result.reason!=='string'||!Array.isArray(result.removed)||result.removed.some(name=>!['service.lock','supervisor.lock'].includes(name)))throw new Error('invalid_result');
        resolveResult(result);
      }catch {resolveResult(preserved('recovery_probe_failed'));}
    });
  });
}
