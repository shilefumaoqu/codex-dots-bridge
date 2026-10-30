import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { initProduction } from '../src/runtime.js';
import { processIsAlive } from '../src/maintenance.js';

const delay=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
async function until(check:()=>boolean){for(let i=0;i<600;i++){if(check())return;await delay(25);}assert.fail('diagnostic fixture timed out');}
function childHasExited(pid:number):boolean {
  if(!processIsAlive(pid))return true;
  // A container's PID 1 may not reap an orphan after the deliberately fatal
  // supervisor exit. A zombie has exited even though kill(pid, 0) succeeds.
  if(process.platform!=='linux')return false;
  try {return /^Z\s/.test(readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').slice(1).join(') '));}
  catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT';}
}

for(const failDiagnostic of [false,true])test(`uncaught supervisor diagnostic contains no exception body and preserves fatal exit (I/O fault ${failDiagnostic})`,{timeout:45_000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots lifecycle diagnostic ')),dir=join(root,'data');let child:ChildProcess|undefined;
  try {
    initProduction(dir);const entry=join(root,'fixture main.mjs');
    const supervisorModule=pathToFileURL(resolve('dist/supervisor.js')).href;
    const runtimeModule=pathToFileURL(resolve('dist/runtime.js')).href;
    const injection=failDiagnostic?`const original=fs.writeFileSync;fs.writeFileSync=(path,value,...args)=>{if(String(path).includes('supervisor-state.')&&String(path).endsWith('.tmp')&&JSON.parse(String(value)).phase==='failed')throw new Error('diagnostic I/O failure');return original(path,value,...args);};syncBuiltinESMExports();`:'';
    // Inject after this exact owner and child publish running state. Real Windows
    // startup work can outlast a fixed delay during the full CI suite.
    const trigger=`const fatal=setInterval(()=>{let ready=false;try{const state=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')),lock=JSON.parse(readFileSync(join(dir,'supervisor.lock'),'utf8')),service=JSON.parse(readFileSync(join(dir,'service.lock'),'utf8'));ready=state.phase==='running'&&state.pid===process.pid&&lock.pid===process.pid&&lock.owner===state.owner&&service.pid===state.bridge_pid;}catch{}if(ready){clearInterval(fatal);setImmediate(()=>{throw new Error('private exception body sentinel');});}},25);`;
    writeFileSync(entry,`import fs,{readFileSync,writeFileSync,unlinkSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {createServer} from 'node:http';const dir=process.argv[process.argv.indexOf('--data-dir')+1];if(process.argv.includes('--supervisor')){${injection}const {runSupervisor}=await import(${JSON.stringify(supervisorModule)});${trigger}await runSupervisor(dir,{nodePath:process.execPath,entryPath:process.argv[1]});}else {const {readProductionConfig,writeProductionConfig}=await import(${JSON.stringify(runtimeModule)});const lock=join(dir,'service.lock');writeFileSync(lock,JSON.stringify({pid:process.pid,owner:'fixture-child'}),{flag:'wx'});const server=createServer((_,res)=>res.end('alive'));let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close(()=>{unlinkSync(lock);if(process.connected)process.disconnect();});};process.on('disconnect',stop);process.on('message',m=>{if(m.type==='shutdown')stop();});server.listen(0,'127.0.0.1',()=>{const cfg=readProductionConfig(dir);cfg.endpoint='http://127.0.0.1:'+server.address().port+'/';writeProductionConfig(dir,cfg);process.send({type:'bridge_ready',endpoint:cfg.endpoint});});}`);
    child=spawn(process.execPath,[entry,'run','--supervisor','--data-dir',dir],{windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr!.on('data',value=>{stderr+=String(value);});
    await until(()=>child!.exitCode!==null);assert.equal(child.exitCode,1);assert.ok(stderr.includes('private exception body sentinel'),'original fatal behavior retained');
    const text=readFileSync(join(dir,'supervisor-state.json'),'utf8'),state=JSON.parse(text) as {phase:string;bridge_pid:number;lifecycle?:Array<{event:string}>;error?:string};
    assert.ok(!text.includes('private exception body sentinel'));assert.ok(!text.includes('diagnostic I/O failure'));
    if(failDiagnostic){assert.equal(state.phase,'running');assert.equal(state.error,undefined);}
    else {assert.equal(state.phase,'failed');assert.equal(state.error,'supervisor_uncaught_exception');assert.equal(state.lifecycle!.at(-1)!.event,'uncaught_exception');}
    // A fatal process exit is not orderly cleanup on Windows. Diagnose it without
    // promising child-lock deletion; strict recovery owns any residual locks.
    await until(()=>childHasExited(state.bridge_pid));
    assert.equal(existsSync(join(dir,'supervisor.lock')),true,'crashed owner locks remain for proven recovery');
  }finally {
    if(child?.exitCode===null)child.kill();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});
