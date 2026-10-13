import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isolatedEnvironment } from './tunnel-runner.js';
import { ProbeError } from './store.js';

export interface WindowsBackgroundReceipt { pid:number; sessionId:number }

/** A WMI broker-created process outlives the caller's kill-on-close Job.
 * Receipt proves creation in this session only; readiness belongs to supervisor. */
export async function launchWindowsSupervisor(options:{nodePath:string;entryPath:string;dataDir:string}):Promise<WindowsBackgroundReceipt> {
  if(process.platform!=='win32')throw new ProbeError('background_broker_unavailable');
  const environment:NodeJS.ProcessEnv={};
  const names=new Set<string>();
  for(const [name,value] of Object.entries(isolatedEnvironment())) {
    if(names.has(name.toLowerCase()))continue;
    names.add(name.toLowerCase());environment[name]=value;
  }
  const request={kind:'supervisor',nodePath:resolve(options.nodePath),entryPath:resolve(options.entryPath),dataDir:resolve(options.dataDir),environment};
  const helper=fileURLToPath(new URL('../scripts/launch-background.ps1',import.meta.url));
  return new Promise((resolveReceipt,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{env:environment,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let settled=false,stdout='',overflow=false;
    const finish=(error?:string,receipt?:WindowsBackgroundReceipt)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error)reject(new ProbeError(error));else resolveReceipt(receipt!);
    };
    // Kill only our helper, never a broker-created process. A timeout is unknown,
    // and callers must reconcile instance state rather than create a second one.
    const timer=setTimeout(()=>{child.kill();finish('background_launch_unknown');},20_000);
    child.on('error',()=>finish('background_broker_unavailable'));
    child.stdin.on('error',()=>{/* helper exit is classified by close */});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{if(stdout.length+chunk.length>65536){overflow=true;return;}stdout+=chunk;});
    child.stderr.resume();
    child.on('close',code=>{
      if(settled)return;
      try {
        if(overflow)throw new Error('invalid_receipt');
        const result=JSON.parse(stdout.replace(/^\uFEFF/,'').trim()) as {pid?:unknown;sessionId?:unknown;error?:unknown};
        const errors=['background_launch_rejected','background_broker_unavailable','background_launch_unknown','background_launch_invalid_request'];
        if(code!==0&&typeof result.error==='string'&&errors.includes(result.error))return finish(result.error);
        if(code!==0||!Number.isSafeInteger(result.pid)||Number(result.pid)<1||!Number.isSafeInteger(result.sessionId)||Number(result.sessionId)<0)throw new Error('invalid_receipt');
        finish(undefined,{pid:Number(result.pid),sessionId:Number(result.sessionId)});
      }catch {finish('background_launch_unknown');}
    });
    child.stdin.end(JSON.stringify(request));
  });
}
