import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:net';
import { initProduction, readProductionConfig, writeProductionConfig } from '../src/runtime.js';
import { startSupervisor, stopSupervisor } from '../src/supervisor.js';
import { TaskStore } from '../src/task-store.js';
import { startupDiagnosticPath, writeStartupDiagnostic } from '../src/startup-diagnostics.js';

function fixture(stale=true) {
  const root=mkdtempSync(join(tmpdir(),'dots startup recovery ')),dir=join(root,'data');initProduction(dir);
  if(stale) {
    const owner=randomUUID();
    writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify({owner,pid:2147483000,bridge_pid:2147483001,phase:'running'}));
    writeFileSync(join(dir,'supervisor.lock'),JSON.stringify({owner,pid:2147483000}));
    writeFileSync(join(dir,'service.lock'),JSON.stringify({owner:randomUUID(),pid:2147483001}));
  }
  return {dir,close(){rmSync(root,{recursive:true,force:true});}};
}

test('login retries only a pre-launch transient recovery refusal, once; manual and permanent refusals retain their reasons',{skip:process.platform!=='win32'},async()=>{
  const original=childProcess.execFile;
  try {
    for(const [autostart,reasons,expectedCalls] of [
      [false,['recovery_probe_failed'],1],
      [true,['recovery_probe_failed','requires_manual_recovery'],2],
      [true,['unknown_process_command','recorded_process_unknown'],2],
      [true,['ownership_mismatch'],1],
      [true,['endpoint_active_or_unknown'],1],
    ] as const) {
      const f=fixture();let calls=0;
      childProcess.execFile=((...args:unknown[])=>{
        const argv=args[1],callback=args.at(-1);
        if(Array.isArray(argv)&&argv.includes(f.dir)&&argv.some(value=>String(value).endsWith('recover-reboot-locks.ps1'))&&typeof callback==='function') {
          const reason=reasons[Math.min(calls++,reasons.length-1)]!;
          queueMicrotask(()=>callback(null,JSON.stringify({recovered:false,clearPreviousState:false,removed:[],reason}),''));
          return new EventEmitter() as ChildProcess;
        }
        return (original as (...args:unknown[])=>ChildProcess)(...args);
      }) as typeof childProcess.execFile;syncBuiltinESMExports();
      try {
        await assert.rejects(()=>startSupervisor(f.dir,{nodePath:process.execPath,entryPath:join(process.cwd(),'dist/main.js')},{autostart}),{code:'supervisor_recovery_'+reasons.at(-1)});
        assert.equal(calls,expectedCalls);
        const path=startupDiagnosticPath(f.dir),text=readFileSync(path,'utf8'),diagnostic=JSON.parse(text);
        assert.equal(diagnostic.mode,autostart?'autostart':'manual');assert.equal(diagnostic.outcome,'failed');
        assert.equal(diagnostic.events.filter((event:{stage:string;code:string})=>event.stage==='recovery'&&event.code!=='started').length,calls);
        assert.equal(diagnostic.events.at(-1).code,'supervisor_recovery_'+reasons.at(-1));
        assert.equal(diagnostic.events.some((event:{stage:string})=>event.stage==='launch'),false);
        assert.equal(existsSync(join(f.dir,'startup.json')),false);assert.equal(existsSync(join(f.dir,'service.lock')),true);
        assert.equal(text.includes(f.dir),false);assert.equal(text.includes('2147483000'),false);
      }finally {f.close();}
    }
  }finally {childProcess.execFile=original;syncBuiltinESMExports();}
});

test('login never retries unknown launch results and diagnostic failure cannot mask that result',{skip:process.platform!=='win32'},async()=>{
  const original=childProcess.spawn;
  try {
    for(const foreign of [false,true]) {
      const f=fixture(false);let launches=0;
      if(foreign)writeFileSync(startupDiagnosticPath(f.dir),'foreign file must remain');
      childProcess.spawn=((...args:unknown[])=>{
        const argv=args[1];
        if(Array.isArray(argv)&&argv.some(value=>String(value).endsWith('launch-background.ps1'))) {
          launches++;
          const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
          child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.write('malformed receipt');child.emit('close',1);}));
          return child;
        }
        return (original as (...args:unknown[])=>ChildProcess)(...args);
      }) as typeof childProcess.spawn;syncBuiltinESMExports();
      try {
        await assert.rejects(()=>startSupervisor(f.dir,{nodePath:process.execPath,entryPath:join(process.cwd(),'dist/main.js')},{autostart:true}),{code:'background_launch_unknown'});
        assert.equal(launches,1);
        const text=readFileSync(startupDiagnosticPath(f.dir),'utf8');
        if(foreign)assert.equal(text,'foreign file must remain');
        else {const diagnostic=JSON.parse(text);assert.equal(diagnostic.events.at(-1).code,'background_launch_unknown');assert.equal(diagnostic.events.filter((event:{stage:string})=>event.stage==='retry_wait').length,0);}
      }finally {f.close();}
    }
  }finally {childProcess.spawn=original;syncBuiltinESMExports();}
});

test('startup diagnostics retain foreign files',()=>{
  const f=fixture(false);
  try {
    const path=startupDiagnosticPath(f.dir);writeFileSync(path,'foreign');
    writeStartupDiagnostic(f.dir,{schema:1,owner:'codex-dots-bridge-startup',mode:'manual',outcome:'failed',events:[]});
    assert.equal(readFileSync(path,'utf8'),'foreign');
  }finally {f.close();}
});

test('startup diagnostics replace an existing receipt with real Windows PowerShell 5 and retain valid foreign JSON',()=>{
  const f=fixture(false);
  const original=childProcess.execFileSync,nativeWrites:unknown[]=[];
  try {
    const path=startupDiagnosticPath(f.dir);
    childProcess.execFileSync=((command:unknown,args:unknown,options:unknown)=>{
      const settings=options as {env?:NodeJS.ProcessEnv};
      if(settings?.env?.CODEX_DOTS_STARTUP_PATH!==path)return (original as Function)(command,args,options);
      const started=Date.now();
      try{const result=(original as Function)(command,args,{...settings,stdio:['pipe','pipe','pipe']});nativeWrites.push({elapsedMs:Date.now()-started,status:0});return result;}
      catch(error){const native=error as {code?:string;status?:number;signal?:string;stderr?:Buffer};nativeWrites.push({elapsedMs:Date.now()-started,code:native.code,status:native.status,signal:native.signal,stderr:String(native.stderr??'').slice(0,2400)});throw error;}
    }) as typeof childProcess.execFileSync;syncBuiltinESMExports();
    const first={schema:1 as const,owner:'codex-dots-bridge-startup' as const,mode:'manual' as const,outcome:'failed' as const,events:[]};
    const second={...first,mode:'autostart' as const,outcome:'running' as const};
    writeStartupDiagnostic(f.dir,first);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),first);
    writeStartupDiagnostic(f.dir,second);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),second,JSON.stringify({nativeWrites}));
    if(process.platform==='win32') {
      const script=String.raw`$ErrorActionPreference='Stop';$acl=[IO.File]::GetAccessControl($env:DOTS_TEST_RECEIPT);@{major=$PSVersionTable.PSVersion.Major;owner_valid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;protected=$acl.AreAccessRulesProtected;rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])).Count}|ConvertTo-Json -Compress`;
      const actual=JSON.parse(childProcess.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,env:{...process.env,DOTS_TEST_RECEIPT:path}}));
      assert.equal(actual.major,5);assert.equal(actual.owner_valid,true);assert.equal(actual.protected,true);assert.equal(actual.rules,2);
    }
    const foreign=JSON.stringify({...first,owner:'isolated-foreign-receipt'});writeFileSync(path,foreign);
    writeStartupDiagnostic(f.dir,second);assert.equal(readFileSync(path,'utf8'),foreign);
  }finally {childProcess.execFileSync=original;syncBuiltinESMExports();f.close();}
});

test('autostart and stop conflict before any startup or shutdown side effect',()=>{
  const f=fixture();try {
    const lock=readFileSync(join(f.dir,'service.lock'),'utf8'),config=readFileSync(join(f.dir,'config.json'),'utf8');
    const result=childProcess.spawnSync(process.execPath,[resolve('dist/main.js'),'run','--autostart','--stop','--data-dir',f.dir],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).error,'conflicting_run_modes');
    assert.equal(readFileSync(join(f.dir,'service.lock'),'utf8'),lock);assert.equal(readFileSync(join(f.dir,'config.json'),'utf8'),config);
    assert.equal(existsSync(join(f.dir,'supervisor.stop')),false);assert.equal(existsSync(startupDiagnosticPath(f.dir)),false);
  }finally {f.close();}
});

test('one transient login probe failure then strict recovery starts a real isolated service and retains queued task identity',{skip:process.platform!=='win32',timeout:90_000},async()=>{
  const f=fixture(),original=childProcess.execFile;let started=false,probes=0;
  try {
    const config=readProductionConfig(f.dir),server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));
    writeProductionConfig(f.dir,{...config,endpoint:`http://127.0.0.1:${port}/`});
    const keys=[readFileSync(join(f.dir,'caller.key'),'utf8'),readFileSync(join(f.dir,'worker.key'),'utf8')];
    const store=new TaskStore(join(f.dir,'tasks.sqlite'));let taskId:string;
    try {taskId=store.submit({idempotency_key:randomUUID(),title:'isolated login recovery task',input:{text:'retain the original task'},safe_to_retry:false}).task_id;}finally {store.close();}
    childProcess.execFile=((...args:unknown[])=>{
      const argv=args[1],callback=args.at(-1);
      if(Array.isArray(argv)&&argv.includes(f.dir)&&argv.some(value=>String(value).endsWith('recover-reboot-locks.ps1'))&&typeof callback==='function') {
        probes++;
        if(probes===1) {queueMicrotask(()=>callback(null,JSON.stringify({recovered:false,clearPreviousState:false,removed:[],reason:'recovery_probe_failed'}),''));return new EventEmitter() as ChildProcess;}
      }
      return (original as (...args:unknown[])=>ChildProcess)(...args);
    }) as typeof childProcess.execFile;syncBuiltinESMExports();
    const result=await startSupervisor(f.dir,{nodePath:process.execPath,entryPath:resolve('dist/main.js')},{autostart:true});started=true;
    assert.equal(result.supervisor,'running');assert.equal(probes,2);
    assert.equal((await fetch(new URL('health',readProductionConfig(f.dir).endpoint),{signal:AbortSignal.timeout(5000)})).status,200);
    const diagnostic=JSON.parse(readFileSync(startupDiagnosticPath(f.dir),'utf8'));assert.equal(diagnostic.mode,'autostart');assert.equal(diagnostic.outcome,'running');
    assert.equal(diagnostic.events.filter((event:{stage:string})=>event.stage==='launch').length,1);
    assert.ok(diagnostic.events.some((event:{stage:string;code:string})=>event.stage==='recovery'&&event.code==='same_boot_locks_recovered'));
    assert.equal((await stopSupervisor(f.dir)).supervisor,'stopped');started=false;
    const retained=new TaskStore(join(f.dir,'tasks.sqlite'));try {const task=retained.get(taskId);assert.equal(task.task_id,taskId);assert.equal(task.status,'queued');assert.equal(task.input.text,'retain the original task');}finally {retained.close();}
    assert.equal(readFileSync(join(f.dir,'caller.key'),'utf8'),keys[0]);assert.equal(readFileSync(join(f.dir,'worker.key'),'utf8'),keys[1]);
    assert.equal(readProductionConfig(f.dir).instance_id,config.instance_id);
  }finally {childProcess.execFile=original;syncBuiltinESMExports();if(started)await stopSupervisor(f.dir);f.close();}
});
