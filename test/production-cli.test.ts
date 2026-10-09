import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import test from 'node:test';
import { readProductionConfig, readToken, writeProductionConfig } from '../src/runtime.js';

const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const entry=['--import','tsx','src/main.ts'];
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'codex dots production cli '));const dir=join(root,'private data with spaces');
  const codexHome=join(root,'synthetic codex home');mkdirSync(codexHome);writeFileSync(join(codexHome,'config.toml'),'# keep synthetic Codex settings\n');
  return {root,dir,codexHome,close(){const rel=relative(resolve(tmpdir()),resolve(root));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.startsWith('codex dots production cli '));rmSync(root,{recursive:true,force:true});}};
}
async function cli(args:string[],timeout=20_000) {
  const child=spawn(process.execPath,[...entry,...args],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',c=>stdout+=c.toString());child.stderr.on('data',c=>stderr+=c.toString());
  const code=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('CLI process timed out'));},timeout);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  return {code,stdout,stderr};
}
function json(result:{code:number|null;stdout:string;stderr:string}){assert.equal(result.code,0,result.stdout+result.stderr);return JSON.parse(result.stdout);}
function foreground(dir:string) {
  const child=spawn(process.execPath,[...entry,'run','--foreground','--data-dir',dir],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';
  child.stdout!.on('data',c=>stdout+=c.toString());child.stderr!.on('data',c=>stderr+=c.toString());
  const exited=new Promise<number|null>((r,reject)=>{child.once('exit',r);child.once('error',reject);});
  async function ready() {
    const until=performance.now()+15_000;
    while(performance.now()<until) {
      if(child.exitCode!==null||child.signalCode!==null)throw new Error('foreground exited before becoming ready');
      let endpoint:string|undefined;try{endpoint=readProductionConfig(dir).endpoint;}catch{/* config can be undergoing atomic replacement */}
      if(endpoint){try{const response=await fetch(new URL('health',endpoint),{signal:AbortSignal.timeout(250)});if(response.ok)return endpoint;}catch{/* process still binding or old saved endpoint */}}
      await delay(50);
    }
    throw new Error('foreground failed to become ready');
  }
  async function stop() {
    if(child.exitCode===null&&child.signalCode===null&&child.connected)child.send({type:'shutdown'});
    const result=await Promise.race([exited,delay(5000).then(()=>undefined)]);
    if(result===undefined&&child.exitCode===null&&child.signalCode===null){child.kill();await exited;throw new Error('foreground did not honor graceful IPC shutdown');}
    return result;
  }
  return {child,ready,stop,output:()=>({stdout,stderr})};
}

test('foreground caller status reports actual local Tunnel health without exposing runtime paths',async()=>{
  const f=fixture();let running:ReturnType<typeof foreground>|undefined;
  let healthReady=true;const health=createServer((_request,response)=>{response.statusCode=healthReady?200:503;response.end(healthReady?'ready':'not_ready');});
  try {
    json(await cli(['setup','--no-register','--data-dir',f.dir]));running=foreground(f.dir);const endpoint=await running.ready();
    const status=async()=>{const response=await fetch(new URL('control/dots_status',endpoint),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+readToken(f.dir,'caller')},body:'{}',signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return await response.json() as any;};
    const unconfigured=await status();assert.equal(unconfigured.diagnostics,'available');assert.equal(unconfigured.tunnel_configured,false);assert.equal(unconfigured.tunnel_health,'not_configured');assert.equal(unconfigured.service_reachable,true);assert.equal(unconfigured.bridge,'running');
    const config=readProductionConfig(f.dir);writeProductionConfig(f.dir,{...config,tunnel:{tunnel_id:'tunnel_synthetic',organization_id:'synthetic-org',client_path:join(f.root,'PRIVATE_CLIENT.exe'),key_file:join(f.root,'PRIVATE_KEY.env')}});
    assert.equal((await status()).tunnel_health,'unknown');
    await new Promise<void>(resolve=>health.listen(0,'127.0.0.1',resolve));const address=health.address();assert.ok(address&&typeof address==='object');
    writeFileSync(join(f.dir,'tunnel-health.url'),'http://127.0.0.1:'+address.port+'/');
    const ready=await status();assert.equal(ready.tunnel_health,'ready');assert.equal(ready.tunnel_configured,true);assert.equal(ready.diagnostics,'available');
    healthReady=false;assert.equal((await status()).tunnel_health,'not_ready');
    await new Promise<void>((resolve,reject)=>health.close(error=>error?reject(error):resolve()));
    assert.equal((await status()).tunnel_health,'unreachable');
    for(const secret of [f.root,'PRIVATE_CLIENT','PRIVATE_KEY',readToken(f.dir,'caller')])assert.ok(!JSON.stringify(ready).includes(secret));
    assert.equal(await running.stop(),0);
  }finally{if(health.listening)await new Promise<void>(resolve=>health.close(()=>resolve()));if(running&&running.child.exitCode===null&&running.child.signalCode===null)await running.stop();f.close();}
});

test('production CLI help/version are available without creating data',async()=>{
  const f=fixture();try {
    const help=await cli(['--help','--data-dir',f.dir]);assert.equal(help.code,0);assert.match(help.stdout,/tasks list\|get\|submit\|message\|followup\|cancel\|ack\|wait/);assert.match(help.stdout,/setup/);assert.equal(existsSync(f.dir),false);
    const version=json(await cli(['--version','--data-dir',f.dir]));assert.equal(version.name,'codex-dots-bridge');assert.match(version.version,/^0\.2\./);assert.equal(existsSync(f.dir),false);
  }finally{f.close();}
});

test('isolated no-register setup handles spaces, preserves credentials and leaves Codex settings untouched',async()=>{
  const f=fixture();try {
    const args=['setup','--no-register','--data-dir',f.dir,'--codex-home',f.codexHome];
    const setup=json(await cli(args));assert.equal(setup.mcp,'not_registered');assert.equal(setup.data_dir,f.dir);assert.equal(setup.tunnel,'requires_official_tunnel_account_setup');
    const initial=readProductionConfig(f.dir),caller=readToken(f.dir,'caller'),worker=readToken(f.dir,'worker');assert.notEqual(caller,worker);assert.equal(initial.owner,'codex-dots-bridge');assert.equal(initial.endpoint,undefined);
    json(await cli(args));assert.equal(readProductionConfig(f.dir).instance_id,initial.instance_id);assert.equal(readToken(f.dir,'caller'),caller);assert.equal(readToken(f.dir,'worker'),worker);
    assert.equal(readFileSync(join(f.codexHome,'config.toml'),'utf8'),'# keep synthetic Codex settings\n');assert.deepEqual(readdirSync(f.codexHome),['config.toml']);
    for(const secret of [caller,worker])assert.ok(!setup.next.includes(secret));
    const invalid=json(await cli(['run','--stop','--data-dir',f.dir]));assert.equal(invalid.supervisor,'stopped');assert.equal(invalid.dot_tasks,'not_cancelled');
    assert.equal(existsSync(join(f.dir,'tasks.sqlite')),false);
  }finally{f.close();}
});

test('real foreground CLI serves task commands, defaults to list summaries and releases its own lock on IPC shutdown',async()=>{
  const f=fixture();let running:ReturnType<typeof foreground>|undefined;
  try {
    json(await cli(['setup','--no-register','--data-dir',f.dir]));running=foreground(f.dir);const endpoint=await running.ready();assert.ok(existsSync(join(f.dir,'service.lock')));
    const lock=JSON.parse(readFileSync(join(f.dir,'service.lock'),'utf8'));assert.equal(lock.pid,running.child.pid);
    const caller=readToken(f.dir,'caller'),worker=readToken(f.dir,'worker');
    const submitted=json(await cli(['tasks','submit','--data-dir',f.dir,'--idempotency-key','cli-task','--title','Synthetic title','--text','Private synthetic task body']));assert.equal(submitted.status,'queued');assert.equal(submitted.input.text,'Private synthetic task body');
    const listed=json(await cli(['tasks','list','--data-dir',f.dir]));assert.equal(listed.length,1);assert.equal(listed[0].task_id,submitted.task_id);assert.deepEqual(Object.keys(listed[0]).sort(),['task_id','title','status','input_revision','change_sequence'].sort());assert.ok(!JSON.stringify(listed).includes(submitted.input.text));
    const request=join(f.root,'request with spaces.json');writeFileSync(request,JSON.stringify({task_id:submitted.task_id,message_key:'cli-message',text:'Synthetic revised requirement'}));
    const updated=json(await cli(['tasks','message','--request',request,'--data-dir',f.dir]));assert.equal(updated.input_revision,2);
    const wait=json(await cli(['tasks','wait','--data-dir',f.dir,'--task',submitted.task_id,'--after',String(updated.change_sequence),'--timeout','0.05']));assert.equal(wait.timed_out,true);assert.equal(wait.task.status,'queued');assert.equal(wait.task.attempt,0);
    const invalid=await cli(['tasks','wait','--data-dir',f.dir,'--task',submitted.task_id,'--timeout','21']);assert.equal(invalid.code,1);assert.equal(JSON.parse(invalid.stdout).error,'invalid_parameters');
    const blocked=await cli(['run','--foreground','--data-dir',f.dir]);assert.equal(blocked.code,1);assert.equal(JSON.parse(blocked.stdout).error,'service_already_running');assert.equal(JSON.parse(readFileSync(join(f.dir,'service.lock'),'utf8')).pid,running.child.pid);
    const get=json(await cli(['tasks','get','--data-dir',f.dir,'--task',submitted.task_id]));assert.equal(get.messages[0].text,'Synthetic revised requirement');
    const status=json(await cli(['status','--data-dir',f.dir]));assert.equal(status.instance_id,readProductionConfig(f.dir).instance_id);assert.equal(status.task_bodies,'redacted');
    const before=performance.now();assert.equal(await running.stop(),0);assert.ok(performance.now()-before<5000);assert.equal(existsSync(join(f.dir,'service.lock')),false);
    const output=running.output();assert.equal(output.stdout,'');assert.ok(output.stderr.split('\n').some(line=>{try{return JSON.parse(line).service==='codex-dots-bridge';}catch{return false;}}));for(const secret of [caller,worker])assert.ok(!(output.stdout+output.stderr).includes(secret));
    await assert.rejects(fetch(new URL('health',endpoint),{signal:AbortSignal.timeout(1000)}));
    running=foreground(f.dir);await running.ready();const persisted=json(await cli(['tasks','get','--data-dir',f.dir,'--task',submitted.task_id]));assert.equal(persisted.status,'queued');assert.equal(persisted.input_revision,2);assert.equal(persisted.attempt,0);assert.equal(await running.stop(),0);assert.equal(existsSync(join(f.dir,'service.lock')),false);
  }finally{if(running&&running.child.exitCode===null&&running.child.signalCode===null)await running.stop();f.close();}
});
