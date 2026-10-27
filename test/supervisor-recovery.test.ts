import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import childProcess, { spawn, type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { initProduction, readProductionConfig, writeProductionConfig, protectProductionDirectory } from '../src/runtime.js';
import { launchWindowsTunnel } from '../src/tunnel-runner.js';
import { startSupervisor, stopSupervisor, supervisorStatus, isolatedEnvironment } from '../src/supervisor.js';
import { processIsAlive } from '../src/maintenance.js';

const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await delay(25);}assert.fail('condition timed out');}
function cleanup(path:string){assert.ok(resolve(path).startsWith(resolve(tmpdir())+sep));rmSync(path,{recursive:true,force:true,maxRetries:6,retryDelay:150});}
function publishRenameProbe(file:string,value:unknown,write:(path:string,body:string)=>void,rename:(from:string,to:string)=>void){
  // This fixture is read concurrently; never expose its truncated/in-progress JSON.
  const next=file+'.next';write(next,JSON.stringify(value));rename(next,file);
}
test('rename probe readers retain a complete snapshot while the next observation is being written',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots rename probe publication '));let dir:string|undefined;
  try{
    for(const prior of [[{temp:'previous',code:'EPERM'}],undefined]){
      const file=join(root,prior?'existing.json':'first.json'),next=[{temp:'next',code:'EPERM'}];
      if(prior)writeFileSync(file,JSON.stringify(prior));
      let partialWrites=0;
      publishRenameProbe(file,next,(target,body)=>{
        writeFileSync(target,body.slice(0,1));partialWrites++;
        if(prior)assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),prior);
        else assert.equal(existsSync(file),false,'first receipt must not be visible before it is complete');
        writeFileSync(target,body);
      },renameSync);
      assert.equal(partialWrites,1);assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),next);
      assert.equal(existsSync(file+'.next'),false);
    }
    // Exercise the generated child fixture too, using its captured original rename.
    const f=withoutTunnel(root,'rename-observe');dir=f.dir;
    await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry});
    assert.deepEqual(await stopSupervisor(dir),{supervisor:'stopped',dot_tasks:'not_cancelled'});
    const attempts=JSON.parse(readFileSync(f.renameProbe,'utf8')) as Array<{phase:string;cleanup_complete:boolean}>;
    assert.ok(attempts.some(a=>a.phase==='stopping'));assert.equal(attempts.at(-1)?.cleanup_complete,true);
  }finally{if(dir)try{await stopSupervisor(dir);}catch{}cleanup(root);}
});
function fixture(root:string,stateFault?:'starting'|'stopping'|'stopping-exit-gate'|'starting-handoff'|'tunnel-alive'|'rename-observe'|'rename-EIO'|'rename-owner'|'guardian-ready-overlap'){
  const dir=join(root,'data'),vendor=join(root,"vendor 空格 O'Brien"),entry=join(root,'fixture main.mjs');initProduction(dir);mkdirSync(vendor);
  const exe=join(vendor,'fake-tunnel.exe'),key=join(dir,'tunnel-runtime.env');copyFileSync(process.execPath,exe);writeFileSync(key,'CONTROL_PLANE_API_KEY=synthetic_recovery_key');
  const probe=join(vendor,'probe.json');
  writeFileSync(join(vendor,'run'),`const fs=require('node:fs'),cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});child.unref();fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify({pid:process.pid,descendant:child.pid,key_present:process.env.CONTROL_PLANE_API_KEY==='synthetic_recovery_key'}));console.log(process.env.CONTROL_PLANE_API_KEY);setInterval(()=>{},1000);`);
  const runtime=pathToFileURL(resolve('dist/supervisor.js')).href;
  const configRuntime=pathToFileURL(resolve('dist/runtime.js')).href,diagnostic=join(root,'diagnostic.json');
  const faultPhase=stateFault==='starting-handoff'?'starting':stateFault==='stopping-exit-gate'?'stopping':stateFault;
  const exitGate=join(root,'exit-release'),exitGateReached=join(root,'exit-gate-reached');
  // Fixture-only gate after runSupervisor has published cleanup and released its lock.
  const catchGate=stateFault==='stopping-exit-gate'?`writeFileSync(${JSON.stringify(exitGateReached)},'ready');const deadline=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(exitGate)})&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));`:'';
  let injection=stateFault&&stateFault!=='tunnel-alive'&&stateFault!=='guardian-ready-overlap'&&!stateFault.startsWith('rename-')?`const original=fs.writeFileSync;fs.writeFileSync=(path,value,...options)=>{if(String(path).includes('supervisor-state.')&&String(path).endsWith('.tmp')&&JSON.parse(String(value)).phase===${JSON.stringify(faultPhase)}){const error=new Error('synthetic state I/O fault');error.code='EIO';throw error;}return original(path,value,...options);};syncBuiltinESMExports();`:'';
  const renameProbe=join(root,'rename-probe.json');
  if(stateFault?.startsWith('rename-'))injection+=`const rename=fs.renameSync,attempts=[];fs.renameSync=(from,to)=>{const value=JSON.parse(readFileSync(from,'utf8'));if(value.phase!=='stopping'&&!value.cleanup_complete)return rename(from,to);const attempt={temp:String(from).split(/[\\\\/]/).pop(),phase:value.phase,cleanup_complete:value.cleanup_complete===true};attempts.push(attempt);try{${stateFault==='rename-EIO'?"throw Object.assign(new Error('injected rename'),{code:'EIO'});":stateFault==='rename-owner'?"const next={owner:'next-owner',pid:process.pid,phase:'running'};writeFileSync(join(dir,'supervisor.lock'),JSON.stringify(next));writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify(next));throw Object.assign(new Error('injected owner handoff'),{code:'EPERM'});":"return rename(from,to);"}}catch(error){attempt.code=error.code;throw error;}finally{(${publishRenameProbe.toString()})(${JSON.stringify(renameProbe)},attempts,writeFileSync,rename);}};syncBuiltinESMExports();`;
  if(stateFault==='guardian-ready-overlap')injection+=`const cp=(await import('node:child_process')).default,realSpawn=cp.spawn,rename=fs.renameSync,overlap={rename_failures:0,guardian_failed:false};let launched=false;cp.spawn=(command,args,options)=>{if(options?.env?.CODEX_DOTS_GUARDIAN_CONFIG){launched=true;const child=realSpawn(process.execPath,['-e','process.stdout.write(JSON.stringify({type:"guardian_error"})+String.fromCharCode(10));process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:options.env});overlap.guardian_pid=child.pid;child.stdout.once('data',()=>{overlap.guardian_failed=true;writeFileSync(${JSON.stringify(renameProbe)},JSON.stringify(overlap));});return child;}return realSpawn(command,args,options);};fs.renameSync=(from,to)=>{if(launched&&!overlap.guardian_failed&&JSON.parse(readFileSync(from,'utf8')).phase==='starting'){overlap.rename_failures++;overlap.bridge_pid=JSON.parse(readFileSync(from,'utf8')).bridge_pid;writeFileSync(${JSON.stringify(renameProbe)},JSON.stringify(overlap));throw Object.assign(new Error('injected overlap'),{code:'EPERM'});}return rename(from,to);};syncBuiltinESMExports();`;
  if(stateFault==='starting-handoff')injection+=`const remove=fs.unlinkSync;fs.unlinkSync=(path)=>{remove(path);if(String(path)===join(dir,'supervisor.lock')){const next={owner:'next-owner',pid:process.pid,phase:'running'};writeFileSync(join(dir,'supervisor.lock'),JSON.stringify(next));writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify(next));}};syncBuiltinESMExports();`;
  if(stateFault==='tunnel-alive')injection+=`const kill=process.kill;process.kill=function(pid,signal){if(signal===0&&fs.existsSync(${JSON.stringify(probe)})&&pid===JSON.parse(readFileSync(${JSON.stringify(probe)},'utf8')).pid)return true;return kill.call(process,pid,signal);};`;
  writeFileSync(entry,`import fs,{readFileSync,writeFileSync,unlinkSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {createServer} from 'node:http';const args=process.argv.slice(2),dir=args[args.indexOf('--data-dir')+1];if(args.includes('--supervisor')){${injection}const {runSupervisor}=await import(${JSON.stringify(runtime)});try{await runSupervisor(dir,{nodePath:process.execPath,entryPath:process.argv[1]});}catch(error){${catchGate}writeFileSync(${JSON.stringify(diagnostic)},JSON.stringify({error:error.code}));process.exitCode=1;}}else {const {readProductionConfig,writeProductionConfig}=await import(${JSON.stringify(configRuntime)});const lock=join(dir,'service.lock');try{writeFileSync(lock,JSON.stringify({pid:process.pid,owner:'fixture'}),{flag:'wx'});}catch{process.exit(1);}const server=createServer((_,res)=>res.end('alive'));let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close(()=>{unlinkSync(lock);if(process.connected)process.disconnect();});};process.on('message',m=>{if(m.type==='shutdown')stop();});process.once('disconnect',stop);server.listen(0,'127.0.0.1',()=>{const cfg=readProductionConfig(dir);cfg.endpoint='http://127.0.0.1:'+server.address().port+'/';writeProductionConfig(dir,cfg);process.send?.({type:'bridge_ready',endpoint:cfg.endpoint});});}`);
  writeProductionConfig(dir,{...readProductionConfig(dir),tunnel:{tunnel_id:'tunnel_test',organization_id:'org_test',client_path:exe,key_file:key}});protectProductionDirectory(dir);
  return {dir,exe,key,probe,entry,diagnostic,renameProbe,exitGate,exitGateReached};
}

type ProcessObservation={role:string;pid:number;started_utc:string;exited:boolean;exit_utc:string|null};
type ProcessSnapshot={observed_utc:string;processes:ProcessObservation[]};
// Open and retain each Windows process handle before stop. HasExited then observes
// the original instance even if its numeric PID is reused. Never read command lines.
async function observeFixtureProcesses(roles:Record<string,number>){
  const script=String.raw`$ErrorActionPreference='Stop';$held=@();try{
    $roles=ConvertFrom-Json $env:DOTS_TEST_PROCESS_ROLES
    foreach($role in $roles.PSObject.Properties){
      $p=[Diagnostics.Process]::GetProcessById([int]$role.Value);$null=$p.Handle
      $held+=@{role=$role.Name;process=$p;pid=$p.Id;started=$p.StartTime.ToUniversalTime().ToString('o')}
    }
    function Snapshot {
      $items=@(foreach($h in $held){$exited=$h.process.HasExited;$exit=$null;if($exited){$exit=$h.process.ExitTime.ToUniversalTime().ToString('o')};@{role=$h.role;pid=$h.pid;started_utc=$h.started;exited=$exited;exit_utc=$exit}})
      @{observed_utc=[DateTime]::UtcNow.ToString('o');processes=$items}|ConvertTo-Json -Compress -Depth 5
    }
    Snapshot
    while($null -ne ($line=[Console]::ReadLine())){
      if($line -eq 'wait'){$deadline=[DateTime]::UtcNow.AddSeconds(10);do{$alive=@($held|Where-Object{-not $_.process.HasExited});if($alive.Count -eq 0){break};[Threading.Thread]::Sleep(10)}while([DateTime]::UtcNow -lt $deadline)}
      Snapshot
    }
  }finally{foreach($h in $held){$h.process.Dispose()}}`;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,DOTS_TEST_PROCESS_ROLES:JSON.stringify(roles)}});
  let buffer='',errorOutput='',ended=false;
  const queued:ProcessSnapshot[]=[],pending:Array<{resolve:(s:ProcessSnapshot)=>void;reject:(error:Error)=>void}>=[];
  child.stderr!.on('data',chunk=>{errorOutput+=chunk.toString();});
  child.stdout!.on('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;const value=JSON.parse(line) as ProcessSnapshot;const waiting=pending.shift();if(waiting)waiting.resolve(value);else queued.push(value);}});
  const fail=(error:Error)=>{ended=true;for(const waiting of pending.splice(0))waiting.reject(error);};
  child.once('error',fail);child.once('exit',code=>fail(new Error(`fixture_observer_exited_${code}: ${errorOutput}`)));
  async function read(){
    if(queued.length)return queued.shift()!;
    if(ended)throw new Error(`fixture_observer_unavailable: ${errorOutput}`);
    return new Promise<ProcessSnapshot>((resolve,reject)=>{
      const timer=setTimeout(()=>{const index=pending.indexOf(request);if(index>=0)pending.splice(index,1);reject(new Error('fixture_observer_timeout'));},15000);
      const request={resolve:(value:ProcessSnapshot)=>{clearTimeout(timer);resolve(value);},reject:(error:Error)=>{clearTimeout(timer);reject(error);}};pending.push(request);
    });
  }
  try{const initial=await read();return {initial,async snapshot(){child.stdin!.write('snapshot\n');return read();},async waitForExit(){child.stdin!.write('wait\n');return read();},async close(){child.stdin!.end();if(child.exitCode===null){await Promise.race([new Promise<void>(done=>child.once('exit',()=>done())),delay(2000)]);if(child.exitCode===null)child.kill();}}};}
  catch(error){child.kill();throw error;}
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
    const endpoint=readProductionConfig(f.dir).endpoint;let brokerLaunches=0;const originalSpawn=childProcess.spawn;
    childProcess.spawn=((...args:unknown[])=>{const argv=args[1];if(Array.isArray(argv)&&argv.some(value=>typeof value==='string'&&value.endsWith('launch-background.ps1')))brokerLaunches++;return (originalSpawn as (...args:unknown[])=>ChildProcess)(...args);}) as typeof spawn;syncBuiltinESMExports();
    try {await assert.rejects(()=>startSupervisor(f.dir,{nodePath:process.execPath,entryPath:f.entry}),/bridge_start_failed|background_launch_unknown/);}
    finally {childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
    if(process.platform==='win32')assert.equal(brokerLaunches,1,'an unknown receipt never starts a second supervisor');
    assert.equal(readProductionConfig(f.dir).endpoint,endpoint);assert.equal((await fetch(endpoint!)).status,200);
    foreground.send({type:'shutdown'});await until(()=>foreground!.exitCode!==null);
  }finally{if(foreground?.exitCode===null)foreground.kill('SIGKILL');cleanup(root);}
});
test('state observers see complete JSON throughout real supervisor start and stop transitions',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots atomic state '));let stop=false;let reader:Promise<void>|undefined;
  try{
    const f=fixture(root);const cfg=readProductionConfig(f.dir);delete cfg.tunnel;writeProductionConfig(f.dir,cfg);
    reader=(async()=>{while(!stop){if(existsSync(join(f.dir,'supervisor-state.json'))){assert.doesNotThrow(()=>supervisorStatus(f.dir));}await delay(1);}})();
    await startSupervisor(f.dir,{nodePath:process.execPath,entryPath:f.entry});await stopSupervisor(f.dir);stop=true;await reader;
    const final=JSON.parse(readFileSync(join(f.dir,'supervisor-state.json'),'utf8'));
    assert.equal(final.cleanup_complete,true);for(const field of ['bridge_pid','tunnel_pid','guardian_pid'])assert.equal(final[field],undefined);
  }finally{stop=true;await reader;cleanup(root);}
});

test('completed cleanup ignores a reused live PID and allows a new start',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots completed cleanup '));let dir:string|undefined;
  try{
    const f=fixture(root);dir=f.dir;const cfg=readProductionConfig(dir);delete cfg.tunnel;writeProductionConfig(dir,cfg);
    writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify({owner:randomUUID(),pid:process.pid,phase:'stopping',cleanup_complete:true}));
    assert.equal(supervisorStatus(dir).supervisor,'stopped');assert.equal((await stopSupervisor(dir)).supervisor,'stopped');assert.ok(!existsSync(join(dir,'supervisor.stop')));
    assert.equal((await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry})).supervisor,'running');await stopSupervisor(dir);
  }finally{if(dir){try{await stopSupervisor(dir);}catch{}}cleanup(root);}
});

test('completed cleanup waits for its lock release and does not accept a foreign lock',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots cleanup lock '));
  try{
    const dir=join(root,'data');initProduction(dir);const state={owner:randomUUID(),pid:process.pid,phase:'stopping',cleanup_complete:true};
    const lock=join(dir,'supervisor.lock');writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify(state));writeFileSync(lock,JSON.stringify(state));
    assert.equal(supervisorStatus(dir).supervisor,'stopping');const stopped=stopSupervisor(dir);setTimeout(()=>unlinkSync(lock),50);await stopped;
    const foreign=JSON.stringify({...state,owner:randomUUID()});writeFileSync(lock,foreign);
    assert.equal(supervisorStatus(dir).supervisor,'unknown');await assert.rejects(()=>stopSupervisor(dir),/orphaned_children_require_recovery/);
    assert.equal(readFileSync(lock,'utf8'),foreign);assert.ok(!existsSync(join(dir,'supervisor.stop')));
  }finally{cleanup(root);}
});

test('a failed old owner never overwrites the replacement state after releasing its lock',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots cleanup handoff '));let child:ChildProcess|undefined;
  try{
    const f=fixture(root,'starting-handoff');child=spawn(process.execPath,[f.entry,'run','--supervisor','--data-dir',f.dir],{env:isolatedEnvironment(),windowsHide:true,stdio:'ignore'});await until(()=>child!.exitCode!==null);
    assert.equal(child.exitCode,1);for(const file of ['supervisor.lock','supervisor-state.json'])assert.equal(JSON.parse(readFileSync(join(f.dir,file),'utf8')).owner,'next-owner');
  }finally{if(child?.exitCode===null)child.kill('SIGKILL');cleanup(root);}
});

test('an unconfirmed live Tunnel prevents the completed cleanup marker',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots incomplete cleanup '));let dir:string|undefined;
  try{
    const f=fixture(root,'tunnel-alive');dir=f.dir;await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry});await until(()=>existsSync(f.probe),45000);await assert.rejects(()=>stopSupervisor(dir!),/supervisor_cleanup_unconfirmed/);
    const state=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8'));assert.notEqual(state.cleanup_complete,true);assert.equal(state.error,'supervisor_children_stop_pending');assert.ok(state.tunnel_pid);
    assert.equal(processIsAlive(state.tunnel_pid),false);assert.ok(!existsSync(join(dir,'supervisor.lock')));
  }finally{if(dir){try{await stopSupervisor(dir);}catch{}}cleanup(root);}
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
async function checkStoppingEioCleanup(t:TestContext,holdExit=false){
  const root=mkdtempSync(join(tmpdir(),'dots stopping EIO '));let dir:string|undefined,releaseGate:string|undefined,observer:Awaited<ReturnType<typeof observeFixtureProcesses>>|undefined,final:ProcessSnapshot|undefined,failed=false;
  try{
    const f=fixture(root,holdExit?'stopping-exit-gate':'stopping');dir=f.dir;if(holdExit)releaseGate=f.exitGate;await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry});await until(()=>existsSync(f.probe),45000);
    const state=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')) as {pid:number;bridge_pid:number;guardian_pid:number;tunnel_pid:number};const probe=JSON.parse(readFileSync(f.probe,'utf8')) as {descendant:number};
    const roles={supervisor:state.pid,bridge:state.bridge_pid,guardian:state.guardian_pid,tunnel:state.tunnel_pid,descendant:probe.descendant};
    for(const [role,pid] of Object.entries(roles))assert.ok(processIsAlive(pid),`${role} must be running before stop`);
    observer=await observeFixtureProcesses(roles);assert.deepEqual(observer.initial.processes.map(p=>[p.role,p.pid]),Object.entries(roles));assert.ok(observer.initial.processes.every(p=>!p.exited));
    const stopBegan=Date.now(),result=await stopSupervisor(dir),stopReturned=Date.now();
    const immediate=Object.entries(roles).map(([role,pid])=>({role,pid,alive:processIsAlive(pid)}));
    const atReturn=await observer.snapshot();
    t.diagnostic(JSON.stringify({phase:'stop_returned',stop_began_utc:new Date(stopBegan).toISOString(),stop_returned_utc:new Date(stopReturned).toISOString(),result,initial:observer.initial,immediate,at_return:atReturn}));
    // Their exits are already required by cleanup_complete. Check the held
    // instances' OS exit times; never grant these resources another grace period.
    for(const role of ['bridge','guardian','tunnel']){
      const instance=atReturn.processes.find(p=>p.role===role)!;
      assert.equal(instance.exited,true,`${role} original instance must exit before stop returns`);
      assert.ok(instance.exit_utc&&Date.parse(instance.exit_utc)<=stopReturned,`${role} exited after stop returned: ${JSON.stringify(instance)}`);
    }
    if(holdExit){
      await until(()=>existsSync(f.exitGateReached));
      const held=await observer.snapshot();t.diagnostic(JSON.stringify({phase:'gate_ready',stop_returned_utc:new Date(stopReturned).toISOString(),held}));
      assert.equal(JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')).cleanup_complete,true);
      assert.ok(!existsSync(join(dir,'supervisor.lock')),'completion returned only after releasing its owned lock');
      assert.equal(held.processes.find(p=>p.role==='supervisor')?.exited,false,'same supervisor instance remains held after stop returns');
      writeFileSync(f.exitGate,'release');
    }
    final=await observer.waitForExit();
    t.diagnostic(JSON.stringify({phase:'final',final}));
    assert.deepEqual(result,{supervisor:'stopped',dot_tasks:'not_cancelled',error:'supervisor_io_EIO'});
    assert.ok(final.processes.every(p=>p.exited),`controlled instances still alive after 10s: ${JSON.stringify(final)}`);
    // Only the supervisor's own OS exit and asynchronous Job descendant teardown
    // may lag the receipt. Ten seconds uses this file's existing observation cap.
    assert.ok(!existsSync(join(dir,'supervisor.lock')));assert.ok(!existsSync(join(dir,'service.lock')));assert.ok(!existsSync(join(dir,'supervisor.stop')));
    assert.deepEqual(JSON.parse(readFileSync(f.diagnostic,'utf8')),{error:'supervisor_io_EIO'});assert.equal(supervisorStatus(dir).error,'supervisor_io_EIO');
  }catch(error){failed=true;throw error;}
  finally{
    const cleanupErrors:unknown[]=[];
    const attempt=async(label:string,step:()=>unknown|Promise<unknown>)=>{try{await step();}catch(error){cleanupErrors.push(error);try{t.diagnostic(JSON.stringify({phase:'cleanup_error',step:label,error:String(error)}));}catch{/* diagnostic errors must not mask the original assertion */}}};
    await attempt('release_gate',()=>{if(releaseGate)writeFileSync(releaseGate,'release');});
    await attempt('final_observation',async()=>{if(observer){final??=await observer.waitForExit();t.diagnostic(JSON.stringify({phase:'cleanup_final',final}));}});
    await attempt('close_observer',async()=>{await observer?.close();});
    await attempt('stop_fixture',async()=>{if(dir)await stopSupervisor(dir);});
    await attempt('remove_fixture',()=>cleanup(root));
    if(!failed&&cleanupErrors.length)throw cleanupErrors[0];
  }
}
test('stopping state EIO cannot skip guardian, Tunnel tree, bridge or owned lock cleanup',{skip:process.platform!=='win32'},t=>checkStoppingEioCleanup(t));
test('completed EIO cleanup may return before the same supervisor instance exits',{skip:process.platform!=='win32'},t=>checkStoppingEioCleanup(t,true));
test('first starting state EIO releases the acquired supervisor lock before exiting',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots initial EIO '));let child:ChildProcess|undefined;
  try{
    const f=fixture(root,'starting');child=spawn(process.execPath,[f.entry,'run','--supervisor','--data-dir',f.dir],{env:isolatedEnvironment(),windowsHide:true,stdio:'ignore'});await until(()=>child!.exitCode!==null);
    assert.equal(child.exitCode,1);assert.ok(!existsSync(join(f.dir,'supervisor.lock')));assert.ok(!existsSync(join(f.dir,'service.lock')));assert.ok(!existsSync(f.probe));assert.deepEqual(JSON.parse(readFileSync(f.diagnostic,'utf8')),{error:'supervisor_io_EIO'});
  }finally{if(child?.exitCode===null)child.kill('SIGKILL');cleanup(root);}
});

function withoutTunnel(root:string,fault:'rename-observe'|'rename-EIO'|'rename-owner'){
  const f=fixture(root,fault),cfg=readProductionConfig(f.dir);delete cfg.tunnel;writeProductionConfig(f.dir,cfg);return f;
}
async function holdRecoveryMetadata(file:string){
  const script=String.raw`$ErrorActionPreference='Stop';$file=$null;try{. $env:DOTS_TEST_SCRIPT;$file=[DotsRebootFile]::new($env:DOTS_TEST_FILE,$false);$null=$file.Read();[Console]::WriteLine('ready');[Console]::Out.Flush();$null=[Console]::ReadLine()}finally{if($file){$file.Dispose()}}`;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,DOTS_TEST_SCRIPT:resolve('scripts/recover-reboot-locks.ps1'),DOTS_TEST_FILE:file}});
  try{await new Promise<void>((done,reject)=>{
    const timer=setTimeout(()=>reject(new Error('metadata_holder_timeout')),10000);let buffer='';
    child.stdout!.on('data',chunk=>{buffer+=chunk.toString();if(buffer.includes('ready')){clearTimeout(timer);done();}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('metadata_holder_exited_before_ready'));});
  });}catch(error){if(child.exitCode===null)child.kill();throw error;}
  return child;
}
async function releaseMetadata(child:ChildProcess){const exited=new Promise<void>(done=>child.once('exit',()=>done()));child.stdin!.end('release\n');await exited;}

test('real recovery metadata handle releases during bounded rename retry without partial JSON or sticky error',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots state retry release '));let holder:ChildProcess|undefined,dir:string|undefined,reading=true,reader:Promise<void>|undefined;
  try{
    const f=withoutTunnel(root,'rename-observe');dir=f.dir;await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry});
    const statePath=join(dir,'supervisor-state.json');holder=await holdRecoveryMetadata(statePath);
    reader=(async()=>{while(reading){assert.doesNotThrow(()=>JSON.parse(readFileSync(statePath,'utf8')));await delay(1);}})();
    const stopped=stopSupervisor(dir);await until(()=>existsSync(f.renameProbe)&&JSON.parse(readFileSync(f.renameProbe,'utf8')).some((a:{code?:string})=>a.code==='EPERM'));
    await releaseMetadata(holder);holder=undefined;assert.deepEqual(await stopped,{supervisor:'stopped',dot_tasks:'not_cancelled'});
    reading=false;await reader;const final=JSON.parse(readFileSync(statePath,'utf8'));assert.equal(final.cleanup_complete,true);assert.equal(final.error,undefined);
    const attempts=JSON.parse(readFileSync(f.renameProbe,'utf8')) as Array<{temp:string;code?:string}>;
    assert.ok(attempts.length>=3);assert.equal(attempts[0]!.temp,attempts[1]!.temp,'retry reuses one immutable temp');
    assert.ok(!existsSync(join(dir,'supervisor.lock')));assert.ok(!existsSync(join(dir,'service.lock')));
  }finally{reading=false;if(holder){holder.kill();}if(reader)await reader;if(dir)try{await stopSupervisor(dir);}catch{}cleanup(root);}
});

test('persistent recovery metadata hold exhausts publication budget but cleans children and refuses stop success',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots state retry exhaustion '));let holder:ChildProcess|undefined,dir:string|undefined;
  try{
    const f=withoutTunnel(root,'rename-observe');dir=f.dir;await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry});
    const state=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')) as {pid:number;bridge_pid:number};holder=await holdRecoveryMetadata(join(dir,'supervisor-state.json'));
    const began=performance.now();await assert.rejects(()=>stopSupervisor(dir!),/supervisor_cleanup_unconfirmed/);const elapsed=performance.now()-began;
    assert.ok(elapsed<10000,'bounded publication exhaustion must not wait the 30s stop budget');
    assert.equal(processIsAlive(state.pid),false);assert.equal(processIsAlive(state.bridge_pid),false);
    assert.equal(JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')).cleanup_complete,undefined);
    assert.ok(!existsSync(join(dir,'supervisor.lock')));assert.ok(!existsSync(join(dir,'service.lock')));
    const attempts=JSON.parse(readFileSync(f.renameProbe,'utf8')) as Array<{temp:string;code:string}>;
    assert.equal(new Set(attempts.map(a=>a.temp)).size,2,'only stopping and final payloads are written');assert.ok(attempts.length>2);assert.ok(attempts.every(a=>a.code==='EPERM'));
    assert.deepEqual(JSON.parse(readFileSync(f.diagnostic,'utf8')),{error:'supervisor_io_EPERM'});
    await releaseMetadata(holder);holder=undefined;
  }finally{holder?.kill();if(dir)try{await stopSupervisor(dir);}catch{}cleanup(root);}
});

test('rename EIO is never retried or converted to clean stop',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots state rename EIO '));let dir:string|undefined;
  try{
    const f=withoutTunnel(root,'rename-EIO');dir=f.dir;await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry});
    await assert.rejects(()=>stopSupervisor(dir!),/supervisor_cleanup_unconfirmed/);
    const attempts=JSON.parse(readFileSync(f.renameProbe,'utf8')) as Array<{code:string}>;assert.equal(attempts.length,2);assert.ok(attempts.every(a=>a.code==='EIO'));
    assert.deepEqual(JSON.parse(readFileSync(f.diagnostic,'utf8')),{error:'supervisor_io_EIO'});assert.equal(JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')).cleanup_complete,undefined);
  }finally{if(dir)try{await stopSupervisor(dir);}catch{}cleanup(root);}
});

test('owner change during rename retry preserves replacement state and lock',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots state retry owner '));let dir:string|undefined;
  try{
    const f=withoutTunnel(root,'rename-owner');dir=f.dir;await startSupervisor(dir,{nodePath:process.execPath,entryPath:f.entry});
    const pid=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')).pid as number;
    await assert.rejects(()=>stopSupervisor(dir!),/supervisor_ownership_mismatch/);await until(()=>!processIsAlive(pid));
    for(const name of ['supervisor-state.json','supervisor.lock'])assert.equal(JSON.parse(readFileSync(join(dir,name),'utf8')).owner,'next-owner');
    assert.equal(JSON.parse(readFileSync(f.renameProbe,'utf8')).length,1,'ownership failure precedes another rename');
  }finally{cleanup(root);}
});

test('stop without previous state preserves its idempotent process-status meaning',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots empty stop '));try{const dir=join(root,'data');initProduction(dir);assert.deepEqual(await stopSupervisor(dir),{supervisor:'stopped',dot_tasks:'not_cancelled'});}finally{cleanup(root);}
});

test('stop rereads the final receipt published between its snapshot and owner exit',async()=>{
  for(const outcome of ['complete','foreign','missing'] as const){
    const root=mkdtempSync(join(tmpdir(),'dots stop final race ')),dir=join(root,'data'),pid=2147483000;
    const kill=process.kill;let checks=0;
    try{
      initProduction(dir);const previous={owner:randomUUID(),pid,phase:'running'};
      const statePath=join(dir,'supervisor-state.json'),lockPath=join(dir,'supervisor.lock');
      writeFileSync(statePath,JSON.stringify(previous));writeFileSync(lockPath,JSON.stringify(previous));
      process.kill=((target:number,signal?:NodeJS.Signals|number)=>{
        if(target!==pid||signal!==0)return kill(target,signal);
        if(++checks===1)return true;
        // Deterministically publish/exit after stop read the old state and lock.
        if(outcome==='complete'){writeFileSync(statePath,JSON.stringify({...previous,phase:'stopping',cleanup_complete:true}));unlinkSync(lockPath);}
        else if(outcome==='foreign'){const next={...previous,owner:randomUUID()};writeFileSync(statePath,JSON.stringify(next));writeFileSync(lockPath,JSON.stringify(next));}
        else unlinkSync(lockPath);
        throw Object.assign(new Error('synthetic process exit'),{code:'ESRCH'});
      }) as typeof process.kill;
      if(outcome==='complete')assert.deepEqual(await stopSupervisor(dir),{supervisor:'stopped',dot_tasks:'not_cancelled'});
      else await assert.rejects(()=>stopSupervisor(dir),outcome==='foreign'?/supervisor_ownership_mismatch/:/supervisor_cleanup_unconfirmed/);
      assert.equal(checks,2);
    }finally{process.kill=kill;cleanup(root);}
  }
});

test('guardian ready rejection overlapping starting-state retry is observed under default Node semantics',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'dots guardian ready overlap '));let child:ChildProcess|undefined;
  try{
    const f=fixture(root,'guardian-ready-overlap');
    child=spawn(process.execPath,[f.entry,'run','--supervisor','--data-dir',f.dir],{env:isolatedEnvironment(),windowsHide:true,stdio:'ignore'});
    await until(()=>child!.exitCode!==null,20000);
    const overlap=JSON.parse(readFileSync(f.renameProbe,'utf8')) as {rename_failures:number;guardian_failed:boolean;guardian_pid:number;bridge_pid:number};
    const final=JSON.parse(readFileSync(join(f.dir,'supervisor-state.json'),'utf8'));
    t.diagnostic(JSON.stringify({rename_failures:overlap.rename_failures,guardian_failed:overlap.guardian_failed,supervisor_exit:child.exitCode,cleanup_complete:final.cleanup_complete??false,error:final.error??null,finally_receipt:existsSync(f.diagnostic)}));
    assert.ok(overlap.rename_failures>0,'readiness rejection really overlaps a yielding state retry');assert.equal(overlap.guardian_failed,true);
    assert.ok(existsSync(f.diagnostic),'protected finally must finish instead of default unhandled rejection exit');
    assert.equal(child.exitCode,1);assert.deepEqual(JSON.parse(readFileSync(f.diagnostic,'utf8')),{error:'tunnel_guardian_start_failed'});
    assert.equal(final.cleanup_complete,true);assert.equal(final.error,'tunnel_guardian_start_failed');
    assert.ok(!final.lifecycle?.some((event:{event:string})=>event.event==='uncaught_exception'),'default unhandled rejection must not bypass finally');
    for(const pid of [overlap.guardian_pid,overlap.bridge_pid])assert.equal(processIsAlive(pid),false);
    assert.ok(!existsSync(join(f.dir,'supervisor.lock')));assert.ok(!existsSync(join(f.dir,'service.lock')));
  }finally{if(child?.exitCode===null)child.kill('SIGKILL');cleanup(root);}
});

