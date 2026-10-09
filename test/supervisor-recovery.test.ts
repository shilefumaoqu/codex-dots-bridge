import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initProduction, readProductionConfig, writeProductionConfig, protectProductionDirectory } from '../src/runtime.js';
import { launchWindowsTunnel } from '../src/tunnel-runner.js';
import { startSupervisor, stopSupervisor, supervisorStatus, isolatedEnvironment } from '../src/supervisor.js';
import { processIsAlive } from '../src/maintenance.js';

const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await delay(25);}assert.fail('condition timed out');}
function cleanup(path:string){assert.ok(resolve(path).startsWith(resolve(tmpdir())+sep));rmSync(path,{recursive:true,force:true,maxRetries:6,retryDelay:150});}
function fixture(root:string,stateFault?:'starting'|'stopping'){
  const dir=join(root,'data'),vendor=join(root,"vendor 空格 O'Brien"),entry=join(root,'fixture main.mjs');initProduction(dir);mkdirSync(vendor);
  const exe=join(vendor,'fake-tunnel.exe'),key=join(dir,'tunnel-runtime.env');copyFileSync(process.execPath,exe);writeFileSync(key,'CONTROL_PLANE_API_KEY=synthetic_recovery_key');
  const probe=join(vendor,'probe.json');
  writeFileSync(join(vendor,'run'),`const fs=require('node:fs'),cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});child.unref();fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify({pid:process.pid,descendant:child.pid,key_present:process.env.CONTROL_PLANE_API_KEY==='synthetic_recovery_key'}));console.log(process.env.CONTROL_PLANE_API_KEY);setInterval(()=>{},1000);`);
  const runtime=pathToFileURL(resolve('dist/supervisor.js')).href;
  const configRuntime=pathToFileURL(resolve('dist/runtime.js')).href,diagnostic=join(root,'diagnostic.json');
  const injection=stateFault?`const original=fs.writeFileSync;fs.writeFileSync=(path,value,...options)=>{if(String(path).includes('supervisor-state.')&&String(path).endsWith('.tmp')&&JSON.parse(String(value)).phase===${JSON.stringify(stateFault)}){const error=new Error('synthetic state I/O fault');error.code='EIO';throw error;}return original(path,value,...options);};syncBuiltinESMExports();`:'';
  writeFileSync(entry,`import fs,{readFileSync,writeFileSync,unlinkSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {createServer} from 'node:http';const args=process.argv.slice(2),dir=args[args.indexOf('--data-dir')+1];if(args.includes('--supervisor')){${injection}const {runSupervisor}=await import(${JSON.stringify(runtime)});try{await runSupervisor(dir,{nodePath:process.execPath,entryPath:process.argv[1]});}catch(error){writeFileSync(${JSON.stringify(diagnostic)},JSON.stringify({error:error.code}));process.exitCode=1;}}else {const {readProductionConfig,writeProductionConfig}=await import(${JSON.stringify(configRuntime)});const lock=join(dir,'service.lock');try{writeFileSync(lock,JSON.stringify({pid:process.pid,owner:'fixture'}),{flag:'wx'});}catch{process.exit(1);}const server=createServer((_,res)=>res.end('alive'));let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close(()=>{unlinkSync(lock);if(process.connected)process.disconnect();});};process.on('message',m=>{if(m.type==='shutdown')stop();});process.once('disconnect',stop);server.listen(0,'127.0.0.1',()=>{const cfg=readProductionConfig(dir);cfg.endpoint='http://127.0.0.1:'+server.address().port+'/';writeProductionConfig(dir,cfg);process.send?.({type:'bridge_ready',endpoint:cfg.endpoint});});}`);
  writeProductionConfig(dir,{...readProductionConfig(dir),tunnel:{tunnel_id:'tunnel_test',organization_id:'org_test',client_path:exe,key_file:key}});protectProductionDirectory(dir);
  return {dir,exe,key,probe,entry,diagnostic};
}
test('Windows Job guardian routes key only to Tunnel and reclaims Tunnel descendants after guardian crash',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots guardian recovery '));let guardian:ChildProcess|undefined;
  try{
    const f=fixture(root);const prior=process.env.CONTROL_PLANE_API_KEY;process.env.CONTROL_PLANE_API_KEY='parent_environment_sentinel';
    let launched;try{launched=launchWindowsTunnel(f.exe,['run','--marker','path with spaces'],f.key);}finally{if(prior===undefined)delete process.env.CONTROL_PLANE_API_KEY;else process.env.CONTROL_PLANE_API_KEY=prior;}
    guardian=launched.process;let output='';guardian.stdout?.on('data',chunk=>{output+=chunk.toString();});const pid=await launched.ready;
    await until(()=>existsSync(f.probe));const probe=JSON.parse(readFileSync(f.probe,'utf8')) as {pid:number;descendant:number;key_present:boolean};assert.equal(probe.pid,pid);assert.equal(probe.key_present,true);assert.ok(processIsAlive(probe.descendant));assert.ok(!guardian.spawnargs.join(' ').includes('synthetic_recovery_key'));assert.ok(!output.includes('synthetic_recovery_key'));assert.ok(!output.includes('parent_environment_sentinel'));assert.ok(output.includes('"guardian_key_present":false'));
    guardian.kill('SIGKILL');await until(()=>!processIsAlive(pid)&&!processIsAlive(probe.descendant));
  }finally{guardian?.stdin?.end();if(guardian?.exitCode===null)guardian.kill('SIGKILL');cleanup(root);}
});
test('supervisor crash closes guardian pipe and reclaims simulated Tunnel tree without falsely reporting live children as stopped',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots supervisor crash '));let supervisorPid:number|undefined;
  try{
    const f=fixture(root);await startSupervisor(f.dir,{nodePath:process.execPath,entryPath:f.entry});await until(()=>existsSync(f.probe),45000);const state=JSON.parse(readFileSync(join(f.dir,'supervisor-state.json'),'utf8')) as {pid:number;guardian_pid:number};supervisorPid=state.pid;
    const probe=JSON.parse(readFileSync(f.probe,'utf8')) as {pid:number;descendant:number};assert.ok(processIsAlive(state.guardian_pid));process.kill(state.pid,'SIGKILL');
    const initial=supervisorStatus(f.dir);if(initial.tunnel==='running'||initial.guardian==='running'||initial.bridge==='running')assert.notEqual(initial.supervisor,'stopped');
    await until(()=>!processIsAlive(probe.pid)&&!processIsAlive(probe.descendant)&&!processIsAlive(state.guardian_pid));assert.equal((await stopSupervisor(f.dir)).supervisor,'stopped');
  }finally{if(supervisorPid&&processIsAlive(supervisorPid))process.kill(supervisorPid,'SIGKILL');cleanup(root);}
});
test('default run cannot disconnect an existing foreground service or overwrite its endpoint',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots existing foreground '));let foreground:ChildProcess|undefined;
  try{
    const f=fixture(root);const cfg=readProductionConfig(f.dir);delete cfg.tunnel;writeProductionConfig(f.dir,cfg);
    foreground=spawn(process.execPath,[f.entry,'run','--foreground','--data-dir',f.dir],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});await new Promise<void>((resolve,reject)=>{foreground!.once('message',()=>resolve());foreground!.once('error',reject);});
    const endpoint=readProductionConfig(f.dir).endpoint;await assert.rejects(()=>startSupervisor(f.dir,{nodePath:process.execPath,entryPath:f.entry}),/bridge_start_failed/);assert.equal(readProductionConfig(f.dir).endpoint,endpoint);assert.equal((await fetch(endpoint!)).status,200);
    foreground.send({type:'shutdown'});await until(()=>foreground!.exitCode!==null);
  }finally{if(foreground?.exitCode===null)foreground.kill('SIGKILL');cleanup(root);}
});
test('state observers see complete JSON throughout real supervisor start and stop transitions',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots atomic state '));let stop=false;let reader:Promise<void>|undefined;
  try{
    const f=fixture(root);const cfg=readProductionConfig(f.dir);delete cfg.tunnel;writeProductionConfig(f.dir,cfg);
    reader=(async()=>{while(!stop){if(existsSync(join(f.dir,'supervisor-state.json'))){assert.doesNotThrow(()=>supervisorStatus(f.dir));}await delay(1);}})();
    await startSupervisor(f.dir,{nodePath:process.execPath,entryPath:f.entry});await stopSupervisor(f.dir);stop=true;await reader;
  }finally{stop=true;await reader;cleanup(root);}
});
test('owned crash temporaries are retained without adopting them or blocking startup',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots crash temp '));let dir:string|undefined;
  try{
    const f=fixture(root);dir=f.dir;const cfg=readProductionConfig(dir);delete cfg.tunnel;writeProductionConfig(dir,cfg);
    const configTemp=join(dir,`config.${randomUUID()}.tmp`),stateTemp=join(dir,`supervisor-state.${randomUUID()}.tmp`);
    writeFileSync(configTemp,'{"incomplete_config":');writeFileSync(stateTemp,'{"incomplete_state":');
    const current=readFileSync(join(dir,'config.json'),'utf8');assert.equal(initProduction(dir).instance_id,cfg.instance_id);assert.equal(readFileSync(join(dir,'config.json'),'utf8'),current);
    await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry});await stopSupervisor(dir);
    assert.equal(readFileSync(configTemp,'utf8'),'{"incomplete_config":');assert.equal(readFileSync(stateTemp,'utf8'),'{"incomplete_state":');
  }finally{if(dir){try{await stopSupervisor(dir);}catch{}}cleanup(root);}
});
test('stopping state EIO cannot skip guardian, Tunnel tree, bridge or owned lock cleanup',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots stopping EIO '));let dir:string|undefined;
  try{
    const f=fixture(root,'stopping');dir=f.dir;await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry});await until(()=>existsSync(f.probe),45000);
    const state=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')) as {pid:number;bridge_pid:number;guardian_pid:number;tunnel_pid:number};const probe=JSON.parse(readFileSync(f.probe,'utf8')) as {descendant:number};
    for(const pid of [state.pid,state.bridge_pid,state.guardian_pid,state.tunnel_pid,probe.descendant])assert.ok(processIsAlive(pid));
    assert.equal((await stopSupervisor(dir)).supervisor,'stopped');
    for(const pid of [state.pid,state.bridge_pid,state.guardian_pid,state.tunnel_pid,probe.descendant])assert.equal(processIsAlive(pid),false);
    assert.ok(!existsSync(join(dir,'supervisor.lock')));assert.ok(!existsSync(join(dir,'service.lock')));assert.ok(!existsSync(join(dir,'supervisor.stop')));
    assert.deepEqual(JSON.parse(readFileSync(f.diagnostic,'utf8')),{error:'supervisor_io_EIO'});assert.equal(supervisorStatus(dir).error,'supervisor_io_EIO');
  }finally{if(dir){try{await stopSupervisor(dir);}catch{}}cleanup(root);}
});
test('first starting state EIO releases the acquired supervisor lock before exiting',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots initial EIO '));let child:ChildProcess|undefined;
  try{
    const f=fixture(root,'starting');child=spawn(process.execPath,[f.entry,'run','--supervisor','--data-dir',f.dir],{env:isolatedEnvironment(),windowsHide:true,stdio:'ignore'});await until(()=>child!.exitCode!==null);
    assert.equal(child.exitCode,1);assert.ok(!existsSync(join(f.dir,'supervisor.lock')));assert.ok(!existsSync(join(f.dir,'service.lock')));assert.ok(!existsSync(f.probe));assert.deepEqual(JSON.parse(readFileSync(f.diagnostic,'utf8')),{error:'supervisor_io_EIO'});
  }finally{if(child?.exitCode===null)child.kill('SIGKILL');cleanup(root);}
});
