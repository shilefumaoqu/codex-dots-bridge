import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess, { spawn, execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { launchWindowsSupervisor } from '../src/windows-background.js';

test('PowerShell launch parameters and old-payload tray rollback keep runner helper',{skip:process.platform!=='win32'},()=>{
  const stdout=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(process.cwd(),'test','windows-background.test.ps1')],{encoding:'utf8',windowsHide:true,timeout:15_000});
  assert.ok(stdout.includes('"result":"passed"'));
});

test('background receipt refusal, unavailable, malformed and timeout never retry',{skip:process.platform!=='win32'},async t=>{
  const original=childProcess.spawn;
  try {
    for(const [kind,expected] of [['refusal','background_launch_rejected'],['unavailable','background_broker_unavailable'],['malformed','background_launch_unknown'],['timeout','background_launch_unknown']] as const) {
      let count=0,kills=0,input='',options:unknown;
      childProcess.spawn=((_exe:unknown,_args:unknown,opts:unknown)=>{
        count++;options=opts;
        const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{kills++;return true;}});
        child.stdin.on('data',chunk=>{input+=chunk;});
        child.stdin.on('finish',()=>{
          queueMicrotask(()=>{
            if(kind==='timeout')return;
            child.stdout.write(kind==='refusal'?JSON.stringify({error:expected}):kind==='unavailable'?JSON.stringify({error:expected}):'broken');
            child.emit('close',1);
          });
        });
        return child;
      }) as typeof childProcess.spawn;
      syncBuiltinESMExports();
      if(kind==='timeout')t.mock.timers.enable({apis:['setTimeout']});
      const rejected=assert.rejects(launchWindowsSupervisor({nodePath:process.execPath,entryPath:join(process.cwd(),'dist','main.js'),dataDir:join(tmpdir(),'dots mock')}),{code:expected});
      if(kind==='timeout')t.mock.timers.tick(20_000);
      await rejected;
      if(kind==='timeout')t.mock.timers.reset();
      assert.equal(count,1);assert.equal(kills,kind==='timeout'?1:0);
      const request=JSON.parse(input);assert.equal(request.kind,'supervisor');assert.equal(request.environment.CONTROL_PLANE_API_KEY,undefined);assert.equal(request.environment.OPENAI_API_KEY,undefined);
      const names=Object.keys(request.environment).map(name=>name.toLowerCase());assert.equal(new Set(names).size,names.length);
      assert.equal((options as {windowsHide:boolean}).windowsHide,true);
    }
  }finally {t.mock.timers.reset();childProcess.spawn=original;syncBuiltinESMExports();}
});

test('real WMI synthetic supervisor outlives its launcher, keeps Unicode argv and isolated environment',{skip:process.platform!=='win32',timeout:40_000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"dots 中文 '$ launch ")),entry=join(root,'main.js'),data=join(root,"数据 '$ 空格"),ready=join(data,'ready.json'),stop=join(data,'stop');
  mkdirSync(data);
  writeFileSync(entry,`const fs=require('node:fs'),path=require('node:path');const dir=process.argv.at(-1);fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({pid:process.pid,args:process.argv.slice(2),keyNames:Object.keys(process.env).filter(n=>/KEY|TOKEN|SECRET|NODE_OPTIONS/.test(n))}));const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'stop'))){clearInterval(timer);process.exit(0)}},100);setTimeout(()=>process.exit(0),30000).unref();`);
  const code=`import {launchWindowsSupervisor} from ${JSON.stringify(new URL('../src/windows-background.ts',import.meta.url).href)};console.log(JSON.stringify(await launchWindowsSupervisor(${JSON.stringify({nodePath:process.execPath,entryPath:entry,dataDir:data})})));`;
  let receipt:{pid:number;sessionId:number}|undefined;
  try {
    const output=await new Promise<string>((resolve,reject)=>{
      const launcher=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),windowsHide:true,env:{...process.env,CONTROL_PLANE_API_KEY:'synthetic-not-a-key',OPENAI_API_KEY:'synthetic-not-a-key'},stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';launcher.stdout.setEncoding('utf8');launcher.stderr.setEncoding('utf8');launcher.stdout.on('data',chunk=>stdout+=chunk);launcher.stderr.on('data',chunk=>stderr+=chunk);launcher.on('error',reject);launcher.on('close',status=>status===0?resolve(stdout):reject(new Error(stderr||stdout)));
    });
    receipt=JSON.parse(output);
    for(let attempt=0;attempt<50&&!existsSync(ready);attempt++)await new Promise(r=>setTimeout(r,100));
    assert.ok(existsSync(ready));
    const actual=JSON.parse(readFileSync(ready,'utf8'));assert.equal(actual.pid,receipt!.pid);assert.deepEqual(actual.args,['run','--supervisor','--data-dir',data]);assert.deepEqual(actual.keyNames,[]);
    await new Promise(r=>setTimeout(r,350));process.kill(receipt!.pid,0);
    const probe=`$ProgressPreference='SilentlyContinue';$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${receipt!.pid}';$parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId);@{session=$p.SessionId;caller=[Diagnostics.Process]::GetCurrentProcess().SessionId;parent=$parent.Name}|ConvertTo-Json -Compress`;
    const observed=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(probe,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}));
    assert.equal(observed.session,observed.caller);assert.equal(observed.session,receipt!.sessionId);assert.equal(observed.parent.toLowerCase(),'wmiprvse.exe');
  }finally {
    writeFileSync(stop,'stop');
    for(let attempt=0;receipt&&attempt<50;attempt++) {try{process.kill(receipt.pid,0);}catch{break;}await new Promise(r=>setTimeout(r,100));}
    rmSync(root,{recursive:true,force:true});
  }
});
