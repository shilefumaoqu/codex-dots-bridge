import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import childProcess, { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { recoverRebootLocks } from '../src/reboot-recovery.js';
import { initProduction, readProductionConfig, writeProductionConfig } from '../src/runtime.js';
import { startSupervisor, stopSupervisor } from '../src/supervisor.js';
import { TaskStore, migrateTaskStorage } from '../src/task-store.js';
import { processIsAlive } from '../src/maintenance.js';
import { activateStorage, assertStorageServingAllowed, migrateStorage } from '../src/storage-migration.js';
import { migrateContextStorage } from '../src/context-service.js';
import { migrateDesktopSnapshotStorage } from '../src/desktop-snapshot-storage.js';

test('recovery fast paths leave fresh and clean instances untouched',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dots reboot fast '));
  try {
    const fresh=await recoverRebootLocks(dir);
    assert.equal(fresh.recovered,false);assert.equal(fresh.clearPreviousState,false);
    if(process.platform==='win32')assert.equal(fresh.reason,'no_previous_state');
    writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify({cleanup_complete:true}));
    const clean=await recoverRebootLocks(dir);assert.equal(clean.recovered,false);
    if(process.platform==='win32')assert.equal(clean.reason,'cleanup_complete');
  }finally {rmSync(dir,{recursive:true,force:true});}
});

test('Windows recovery helper accepts known schemas and preserves locks for invalid ownership',{skip:process.platform!=='win32',timeout:90_000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots recovery schema ownership '));
  try {
    const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));
    const cases=[
      {name:'valid-v1',version:1}, {name:'valid-v2',version:2},
      {name:'unknown-schema',version:3},
      {name:'owner-v1',version:1,owner:'foreign-owner'}, {name:'owner-v2',version:2,owner:'foreign-owner'},
      {name:'uuid-v1',version:1,instance:'not-a-guid'}, {name:'uuid-v2',version:2,instance:'not-a-guid'},
    ];
    for(const example of cases) {
      const dir=join(root,example.name),owner=randomUUID();mkdirSync(dir);
      const files={
        'config.json':JSON.stringify({owner:example.owner??'codex-dots-bridge',schema_version:example.version,instance_id:example.instance??randomUUID(),endpoint:`http://127.0.0.1:${port}/`,
          ...(example.version===2?{storage:{database_version:2,migration_id:randomUUID(),phase:'ready'}}:{})}),
        'supervisor-state.json':JSON.stringify({owner,pid:2147483000,bridge_pid:2147483001,phase:'running'}),
        'supervisor.lock':JSON.stringify({owner,pid:2147483000}),
        'service.lock':JSON.stringify({owner:randomUUID(),pid:2147483001}),
        'tasks.sqlite':'isolated database sentinel', 'worker.key':'isolated credential sentinel',
      };
      for(const [name,body] of Object.entries(files))writeFileSync(join(dir,name),body);
      const result=await recoverRebootLocks(dir),valid=example.name.startsWith('valid-');
      assert.equal(result.recovered,valid,`${example.name}: ${result.reason}`);assert.equal(result.clearPreviousState,valid);
      assert.equal(result.reason,valid?'same_boot_locks_recovered':'unowned_data');
      assert.deepEqual(result.removed,valid?['service.lock','supervisor.lock']:[]);
      for(const [name,body] of Object.entries(files)) {
        if(valid&&name.endsWith('.lock'))assert.equal(existsSync(join(dir,name)),false);
        else assert.equal(readFileSync(join(dir,name),'utf8'),body,`${example.name} preserves ${name}`);
      }
    }
  }finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});

test('startSupervisor recovers migrated schema 2 prior-boot records and starts real dist service without losing tasks',{skip:process.platform!=='win32',timeout:120_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'dots reboot supervisor integration ')),dir=join(root,'data');
  const oldOwner=randomUUID(),dataMarker=randomUUID();let started=false;
  // Observe the real helper's safe receipt without mocking its decision or outputs.
  // startSupervisor retains the exact safe recovery refusal reason.
  const receipts:Array<{reason:string;recovered:boolean;elapsedMs:number}>=[];
  const originalExecFile=childProcess.execFile;
  childProcess.execFile=((...args:unknown[])=>{
    const argv=args[1],callback=args.at(-1);
    if(Array.isArray(argv)&&argv.includes(dir)&&argv.some(value=>typeof value==='string'&&value.endsWith('recover-reboot-locks.ps1'))&&typeof callback==='function') {
      const began=performance.now();
      args[args.length-1]=(error:unknown,stdout:string,stderr:string)=>{
        try {
          const result=JSON.parse(stdout.replace(/^\uFEFF/,'').trim()) as {reason:string;recovered:boolean};
          receipts.push({reason:result.reason,recovered:result.recovered,elapsedMs:Math.round(performance.now()-began)});
        }catch {receipts.push({reason:'receipt_unavailable',recovered:false,elapsedMs:Math.round(performance.now()-began)});}
        callback(error,stdout,stderr);
      };
    }
    return (originalExecFile as (...args:unknown[])=>ChildProcess)(...args);
  }) as typeof childProcess.execFile;
  syncBuiltinESMExports();
  try {
    const config=initProduction(dir);
    const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    const oldPort=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));
    writeProductionConfig(dir,{...config,endpoint:`http://127.0.0.1:${oldPort}/`});
    const keys={caller:readFileSync(join(dir,'caller.key'),'utf8'),worker:readFileSync(join(dir,'worker.key'),'utf8')};
    // Use the same migration and activation path as the CLI, before introducing
    // queued work. A hand-written schema 2 config would not prove serving works.
    const legacyStore=new TaskStore(join(dir,'tasks.sqlite'));legacyStore.close();
    const migration=await migrateStorage(dir,{from:1,to:2,backupDirectory:join(root,'migration-backup'),migrate:db=>{
      migrateTaskStorage(db);migrateContextStorage(db);migrateDesktopSnapshotStorage(db);
    }});
    activateStorage(dir,migration.migration_id);assertStorageServingAllowed(dir);
    const migratedConfig=readProductionConfig(dir);
    assert.ok(migratedConfig.schema_version===2);
    assert.equal(migratedConfig.storage.phase,'ready');assert.equal(migratedConfig.storage.migration_id,migration.migration_id);
    const store=new TaskStore(join(dir,'tasks.sqlite'));
    let taskId:string;
    try {
      taskId=store.submit({idempotency_key:randomUUID(),title:'isolated reboot preservation fixture',input:{text:'synthetic task retained across recovery'},safe_to_retry:false}).task_id;
      store.db.exec('CREATE TABLE isolated_reboot_marker(value TEXT NOT NULL)');
      store.db.prepare('INSERT INTO isolated_reboot_marker(value) VALUES(?)').run(dataMarker);
    }finally {store.close();}
    // A real live PID is deliberately reused in synthetic old metadata. Boot proof
    // must ignore this unrelated current process instead of treating it as the owner.
    writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify({owner:oldOwner,pid:process.pid,bridge_pid:2147483001,phase:'running'}));
    writeFileSync(join(dir,'supervisor.lock'),JSON.stringify({owner:oldOwner,pid:process.pid}));
    writeFileSync(join(dir,'service.lock'),JSON.stringify({owner:randomUUID(),pid:2147483001}));
    const ageScript=String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$old=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().AddMinutes(-5);foreach($name in @('supervisor-state.json','supervisor.lock','service.lock')){$path=[IO.Path]::Combine($env:DOTS_TEST_DIR,$name);[IO.File]::SetCreationTimeUtc($path,$old);[IO.File]::SetLastWriteTimeUtc($path,$old)}`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ageScript,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,DOTS_TEST_DIR:dir}});

    const status=await startSupervisor(dir,{nodePath:process.execPath,entryPath:resolve('dist/main.js')});
    started=true;
    assert.equal(status.supervisor,'running');assert.equal(status.bridge,'running');
    const state=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')) as {owner:string;pid:number;bridge_pid:number;phase:string;cleanup_complete?:boolean};
    assert.equal(state.phase,'running');assert.notEqual(state.owner,oldOwner);assert.notEqual(state.pid,process.pid);
    assert.ok(state.pid>0&&state.bridge_pid>0&&state.bridge_pid!==state.pid);
    const supervisorLock=JSON.parse(readFileSync(join(dir,'supervisor.lock'),'utf8')) as {owner:string;pid:number};
    const serviceLock=JSON.parse(readFileSync(join(dir,'service.lock'),'utf8')) as {owner:string;pid:number};
    assert.equal(supervisorLock.owner,state.owner);assert.equal(supervisorLock.pid,state.pid);assert.equal(serviceLock.pid,state.bridge_pid);
    const runningConfig=readProductionConfig(dir);
    assert.equal(runningConfig.instance_id,config.instance_id);assert.equal(runningConfig.tunnel,undefined);
    assert.ok(runningConfig.schema_version===2);
    assert.deepEqual(runningConfig.storage,migratedConfig.storage);
    const healthResponse=await fetch(new URL('health',runningConfig.endpoint),{signal:AbortSignal.timeout(5000)});
    assert.equal(healthResponse.status,200);
    assert.equal((await healthResponse.json() as {service:string}).service,'codex-dots-bridge');
    const taskResponse=await fetch(new URL('control/dots_get',runningConfig.endpoint),{
      method:'POST',headers:{authorization:`Bearer ${keys.caller.trim()}`,'content-type':'application/json'},
      body:JSON.stringify({task_id:taskId}),signal:AbortSignal.timeout(5000),
    });
    assert.equal(taskResponse.status,200);
    const liveTask=await taskResponse.json() as {task_id:string;status:string};
    assert.equal(liveTask.task_id,taskId);assert.equal(liveTask.status,'queued');
    // A duplicate start probes current metadata while real callers keep reading.
    // The original exclusive metadata handles made these reads fail with EBUSY.
    let probing=true;let readCount=0;
    const reads=(async()=>{
      while(probing) {
        assert.equal(readProductionConfig(dir).instance_id,config.instance_id);
        const observed=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')) as {owner:string;pid:number};
        assert.equal(observed.owner,state.owner);assert.equal(observed.pid,state.pid);
        assert.equal(JSON.parse(readFileSync(join(dir,'service.lock'),'utf8')).pid,state.bridge_pid);
        readCount++;await new Promise(done=>setTimeout(done,10));
      }
    })();
    try {await assert.rejects(()=>startSupervisor(dir,{nodePath:process.execPath,entryPath:resolve('dist/main.js')}),/supervisor_recovery_endpoint_active_or_unknown/);}
    finally {probing=false;await reads;}
    assert.ok(readCount>5,'caller metadata/lock reads remain available during recovery probe');
    const unchanged=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')) as {owner:string;pid:number};
    assert.equal(unchanged.owner,state.owner);assert.equal(unchanged.pid,state.pid);
    assert.equal((await fetch(new URL('health',runningConfig.endpoint),{signal:AbortSignal.timeout(5000)})).status,200);
    // Stop and a concurrent current-boot recovery probe must both finish safely.
    const concurrentRecovery=recoverRebootLocks(dir);
    assert.equal((await stopSupervisor(dir)).supervisor,'stopped');started=false;
    assert.equal((await concurrentRecovery).recovered,false);
    const stoppedState=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')) as {cleanup_complete:boolean};
    assert.equal(stoppedState.cleanup_complete,true);
    assert.equal(existsSync(join(dir,'service.lock')),false);assert.equal(existsSync(join(dir,'supervisor.lock')),false);
    assert.equal(readFileSync(join(dir,'caller.key'),'utf8'),keys.caller);assert.equal(readFileSync(join(dir,'worker.key'),'utf8'),keys.worker);
    const reopened=new TaskStore(join(dir,'tasks.sqlite'));
    try {
      const retainedTask=reopened.get(taskId);
      assert.equal(retainedTask.task_id,taskId);assert.equal(retainedTask.status,'queued');
      assert.equal(retainedTask.input.text,'synthetic task retained across recovery');
      assert.equal((reopened.db.prepare('SELECT value FROM isolated_reboot_marker').get() as {value:string}).value,dataMarker);
    }finally {reopened.close();}
  }finally {
    childProcess.execFile=originalExecFile;syncBuiltinESMExports();
    t.diagnostic(`helper receipts: ${JSON.stringify(receipts)}`);
    const statePath=join(dir,'supervisor-state.json');
    const lastState=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')) as {owner:string;cleanup_complete?:boolean}:undefined;
    if(started||lastState&&lastState.owner!==oldOwner&&lastState.cleanup_complete!==true)await stopSupervisor(dir);
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});

test('Windows API tolerates real stdio/start callers but preserves real foreground owner',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),"dots reboot real 中文 O'Brien "));
  const children:ChildProcess[]=[];
  try {
    const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));
    const entry=join(root,'main.js');
    writeFileSync(entry,`setInterval(()=>{},1000);process.stdout.write('ready\\n');`);
    async function caller(args:string[]) {
      const child=spawn(process.execPath,[entry,...args],{windowsHide:true,stdio:['ignore','pipe','ignore']});children.push(child);
      await new Promise<void>((done,reject)=>{child.stdout!.once('data',()=>done());child.once('error',reject);});return child;
    }
    async function fixture(name:string) {
      const dir=join(root,name),owner=randomUUID();
      mkdirSync(dir);
      writeFileSync(join(dir,'config.json'),JSON.stringify({owner:'codex-dots-bridge',schema_version:1,instance_id:randomUUID(),endpoint:`http://127.0.0.1:${port}/`}));
      writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify({owner,pid:2147483000,bridge_pid:2147483001,phase:'running'}));
      writeFileSync(join(dir,'supervisor.lock'),JSON.stringify({owner,pid:2147483000}));
      writeFileSync(join(dir,'service.lock'),JSON.stringify({owner:randomUUID(),pid:2147483001}));
      const script=String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$old=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().AddMinutes(-5);foreach($name in @('supervisor-state.json','supervisor.lock','service.lock')){$path=[IO.Path]::Combine($env:DOTS_TEST_DIR,$name);[IO.File]::SetCreationTimeUtc($path,$old);[IO.File]::SetLastWriteTimeUtc($path,$old)}`;
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,DOTS_TEST_DIR:dir}});
      return dir;
    }
    const dir=await fixture('callers');
    await caller(['stdio','--data-dir',dir]);await caller(['run','--start','--data-dir',dir]);
    const retained=readFileSync(join(dir,'supervisor-state.json'),'utf8');
    const recovered=await recoverRebootLocks(dir);
    assert.equal(recovered.recovered,true,recovered.reason);assert.equal(recovered.clearPreviousState,true);
    assert.equal(existsSync(join(dir,'service.lock')),false);assert.equal(readFileSync(join(dir,'supervisor-state.json'),'utf8'),retained);
    const activeDir=await fixture('foreground');await caller(['run','--foreground','--data-dir',activeDir]);
    const active=await recoverRebootLocks(activeDir);assert.equal(active.recovered,false);assert.equal(active.reason,'same_data_process_active');
    assert.equal(existsSync(join(activeDir,'service.lock')),true);
  }finally {
    // Only terminate the synthetic processes directly spawned by this test.
    for(const child of children) {if(child.exitCode===null){const exited=new Promise<void>(done=>child.once('exit',()=>done()));child.kill();await exited;}}
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});
  }
});

test('same-boot stale locks ignore a proven later stdio PID and concurrent recoveries preserve task data',{skip:process.platform!=='win32',timeout:90_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'dots same boot reuse ')),dir=join(root,'data');let caller:ChildProcess|undefined;
  try {
    mkdirSync(dir);const owner=randomUUID(),server=createServer();
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));
    const entry=join(root,'main.js');writeFileSync(entry,"setInterval(()=>{},1000);process.stdout.write('ready');");
    caller=spawn(process.execPath,[entry,'stdio','--data-dir',dir],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    await new Promise<void>((done,reject)=>{caller!.stdout!.once('data',()=>done());caller!.once('error',reject);});
    writeFileSync(join(dir,'config.json'),JSON.stringify({owner:'codex-dots-bridge',schema_version:1,instance_id:randomUUID(),endpoint:`http://127.0.0.1:${port}/`}));
    writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify({owner,pid:caller.pid,bridge_pid:2147483001,guardian_pid:2147483002,tunnel_pid:2147483003,phase:'running'}));
    writeFileSync(join(dir,'supervisor.lock'),JSON.stringify({owner,pid:caller.pid}));writeFileSync(join(dir,'service.lock'),JSON.stringify({owner:randomUUID(),pid:2147483001}));
    writeFileSync(join(dir,'tasks.sqlite'),'isolated database sentinel');writeFileSync(join(dir,'worker.key'),'isolated key sentinel');
    const script=String.raw`$ErrorActionPreference='Stop';$old=[DateTime]::UtcNow.AddSeconds(-15);foreach($name in @('supervisor-state.json','supervisor.lock','service.lock')){$path=[IO.Path]::Combine($env:DOTS_TEST_DIR,$name);[IO.File]::SetCreationTimeUtc($path,$old);[IO.File]::SetLastWriteTimeUtc($path,$old)}`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,DOTS_TEST_DIR:dir}});
    const before=readFileSync(join(dir,'supervisor-state.json'),'utf8');
    const measured=await Promise.all([0,1].map(async()=>{const began=performance.now(),result=await recoverRebootLocks(dir);return {result,elapsedMs:Math.round(performance.now()-began)};}));
    const results=measured.map(value=>value.result);
    t.diagnostic('concurrent same-boot receipts: '+JSON.stringify(measured.map(value=>({reason:value.result.reason,recovered:value.result.recovered,elapsedMs:value.elapsedMs}))));
    assert.equal(results.filter(result=>result.recovered).length,1,JSON.stringify(results));
    assert.ok(results.some(result=>result.reason==='same_boot_locks_recovered'));
    assert.equal(existsSync(join(dir,'supervisor.lock')),false);assert.equal(existsSync(join(dir,'service.lock')),false);
    assert.equal(caller.exitCode,null,'reused stdio process is left alive');
    assert.equal(readFileSync(join(dir,'supervisor-state.json'),'utf8'),before);
    assert.equal(readFileSync(join(dir,'tasks.sqlite'),'utf8'),'isolated database sentinel');assert.equal(readFileSync(join(dir,'worker.key'),'utf8'),'isolated key sentinel');
    assert.equal((await recoverRebootLocks(dir)).reason,'same_boot_state_only');
  }finally {
    if(caller?.exitCode===null){const exited=new Promise<void>(done=>caller!.once('exit',()=>done()));caller.kill();await exited;}
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});

test('real same-boot crash records restart dist service and retain queued task identity',{skip:process.platform!=='win32',timeout:90_000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots same boot start ')),dir=join(root,'data');let started=false;
  try {
    const config=initProduction(dir),server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));writeProductionConfig(dir,{...config,endpoint:`http://127.0.0.1:${port}/`});
    const store=new TaskStore(join(dir,'tasks.sqlite'));let taskId:string;
    try {taskId=store.submit({idempotency_key:randomUUID(),title:'same-boot isolated task',input:{text:'preserve this task'},safe_to_retry:false}).task_id;}finally{store.close();}
    const owner=randomUUID();writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify({owner,pid:2147483000,bridge_pid:2147483001,phase:'running'}));
    writeFileSync(join(dir,'supervisor.lock'),JSON.stringify({owner,pid:2147483000}));writeFileSync(join(dir,'service.lock'),JSON.stringify({owner:randomUUID(),pid:2147483001}));
    assert.equal((await startSupervisor(dir,{nodePath:process.execPath,entryPath:resolve('dist/main.js')})).supervisor,'running');started=true;
    const live=readProductionConfig(dir);assert.equal(live.instance_id,config.instance_id);
    assert.equal((await fetch(new URL('health',live.endpoint),{signal:AbortSignal.timeout(5000)})).status,200);
    assert.equal((await stopSupervisor(dir)).supervisor,'stopped');started=false;
    const retained=new TaskStore(join(dir,'tasks.sqlite'));try{const task=retained.get(taskId);assert.equal(task.status,'queued');assert.equal(task.input.text,'preserve this task');}finally{retained.close();}
  }finally {
    if(started)await stopSupervisor(dir);
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});

test('real bridge exit followed by supervisor crash leaves one lock and restart keeps its queued task',{skip:process.platform!=='win32',timeout:120_000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots real single lock crash ')),dir=join(root,'data');let started=false;
  const options={nodePath:process.execPath,entryPath:resolve('dist/main.js')};
  try {
    initProduction(dir);const store=new TaskStore(join(dir,'tasks.sqlite'));let taskId:string;
    try{taskId=store.submit({idempotency_key:randomUUID(),title:'real crash task fixture',input:{text:'same task after real crash'},safe_to_retry:false}).task_id;}finally{store.close();}
    assert.equal((await startSupervisor(dir,options)).supervisor,'running');started=true;
    const previous=JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')) as {owner:string;pid:number;bridge_pid:number};
    assert.equal(JSON.parse(readFileSync(join(dir,'supervisor.lock'),'utf8')).owner,previous.owner);
    // Stop only the confirmed child this test launched. Its supervisor reclaims
    // the service lock, then pauses before restart. Crash that owner in the pause
    // to produce an actual single-lock lifecycle rather than fabricate a lock.
    process.kill(previous.bridge_pid,'SIGTERM');
    for(let i=0;i<200&&existsSync(join(dir,'service.lock'));i++)await new Promise(done=>setTimeout(done,10));
    assert.equal(existsSync(join(dir,'service.lock')),false);
    assert.equal(JSON.parse(readFileSync(join(dir,'supervisor.lock'),'utf8')).owner,previous.owner);
    process.kill(previous.pid,'SIGKILL');started=false;
    for(let i=0;i<200&&(processIsAlive(previous.pid)||processIsAlive(previous.bridge_pid));i++)await new Promise(done=>setTimeout(done,25));
    assert.equal(processIsAlive(previous.pid),false);assert.equal(processIsAlive(previous.bridge_pid),false);
    assert.equal(existsSync(join(dir,'supervisor.lock')),true);assert.equal(existsSync(join(dir,'service.lock')),false,'confirmed child exit before owner crash leaves one lock');
    assert.equal((await startSupervisor(dir,options)).supervisor,'running');started=true;
    assert.notEqual(JSON.parse(readFileSync(join(dir,'supervisor-state.json'),'utf8')).owner,previous.owner);
    assert.equal((await stopSupervisor(dir)).supervisor,'stopped');started=false;
    const retained=new TaskStore(join(dir,'tasks.sqlite'));try{const task=retained.get(taskId);assert.equal(task.status,'queued');assert.equal(task.input.text,'same task after real crash');}finally{retained.close();}
  }finally {
    if(started)await stopSupervisor(dir);
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});
