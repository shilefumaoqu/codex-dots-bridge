import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { readToken, writeProductionConfig } from '../src/runtime.js';
import { getTrayStatus } from '../src/tray-status.js';
import { ProbeError } from '../src/store.js';
import { startupDiagnosticPath } from '../src/startup-diagnostics.js';
const version='0.2.0-alpha.20';
const ready={version,service_reachable:true,task_counts:{queued:2,running:1,waiting_input:1,cancel_requested:1,reconciliation_required:1,completed:8},diagnostics:'available',supervisor:'running',bridge:'running',tunnel_configured:true,tunnel_health:'ready',tunnel:'running',active_subscription_count:1};
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'dots tray status ')),dir=join(root,'data');mkdirSync(dir);
  // Pure status never changes ACL or installation state; this fixture does not require runtime setup.
  const config={owner:'codex-dots-bridge' as const,schema_version:1 as const,instance_id:'11111111-1111-4111-8111-111111111111',endpoint:'http://127.0.0.1:1/',tunnel:{tunnel_id:'tunnel_test',organization_id:'PRIVATE_ACCOUNT',client_path:'PRIVATE_PATH',key_file:'PRIVATE_SECRET'}};
  writeProductionConfig(dir,config);
  const hint={owner:'synthetic-owner',pid:process.pid,phase:'running'};
  writeFileSync(join(dir,'supervisor-state.json'),JSON.stringify(hint));writeFileSync(join(dir,'supervisor.lock'),JSON.stringify({owner:hint.owner,pid:hint.pid}));
  writeFileSync(join(dir,'service.lock'),JSON.stringify({owner:'service-owner',pid:process.pid}));
  return {root,dir,config,hint,close(){rmSync(root,{recursive:true,force:true});}};
}
test('tray projection requires authenticated diagnostics and strips all private fields',async()=>{
  const f=fixture();try {
    let args:unknown;
    const status=await getTrayStatus(f.dir,version,{call:async(dir,name,payload,options)=>{args={dir,name,payload,options};return {...ready,endpoint:'PRIVATE_ENDPOINT',tasks:[{task_id:'PRIVATE_TASK',input:'PRIVATE_BODY'}],error:'PRIVATE_ERROR',key:'PRIVATE_KEY'};}});
    assert.equal(status.state,'ready');assert.equal(status.tone,'green');assert.equal(status.control,'stop');assert.equal(status.inflight_count,6);
    assert.equal(status.service_version,version);assert.deepEqual(status.task_counts,ready.task_counts);
    assert.deepEqual(args,{dir:f.dir,name:'dots_status',payload:{},options:{timeoutMs:2500}});
    assert.equal(JSON.stringify(status).includes('PRIVATE'),false);
  }finally{f.close();}
});
test('tray treats mismatch, missing diagnostics, timeout and identity ambiguity conservatively',async()=>{
  const f=fixture();try {
    const check=(data:unknown)=>getTrayStatus(f.dir,version,{call:async()=>data});
    const mismatch=await check({...ready,version:'0.2.0-alpha.19'});assert.equal(mismatch.state,'mismatch');assert.equal(mismatch.control,'disabled');assert.notEqual(mismatch.tone,'green');
    const absent=await check({...ready,version:undefined});assert.equal(absent.state,'unknown');assert.equal(absent.service_version,null);
    const unavailable=await check({...ready,diagnostics:'unavailable'});assert.equal(unavailable.state,'unknown');assert.equal(unavailable.control,'disabled');
    const timeout=await getTrayStatus(f.dir,version,{call:async()=>{throw new ProbeError('local_service_unreachable');}});
    assert.equal(timeout.state,'unknown');assert.equal(timeout.inflight_count,null);assert.equal(timeout.control,'disabled');
    assert.equal((await check({...ready,task_counts:{...ready.task_counts,unknown:3}})).inflight_count,null);
    writeFileSync(join(f.dir,'supervisor.lock'),JSON.stringify({owner:'foreign',pid:process.pid}));
    const foreign=await check(ready);assert.equal(foreign.state,'unknown');assert.equal(foreign.control,'disabled');
  }finally{f.close();}
});
test('tray requires structured startup readiness when supplied, including the readyz200 auth boundary',async()=>{
  const f=fixture();try {
    for(const [connection,label] of [['auth_required','待授权'],['starting','正在连接'],['failed','未连接'],['unknown','待确认']] as const) {
      const status=await getTrayStatus(f.dir,version,{call:async()=>({...ready,tunnel_connection:connection})});
      assert.equal(status.cloud,label);assert.notEqual(status.state,'ready');assert.notEqual(status.tone,'green');
    }
    const status=await getTrayStatus(f.dir,version,{call:async()=>({...ready,tunnel_connection:'ready'})});assert.equal(status.cloud,'已连接');assert.equal(status.state,'ready');
  }finally{f.close();}
});
test('confirmed cleanup is stopped; starting and prolonged stopping never show green',async()=>{
  const f=fixture();try {
    const fail=async()=>{throw new ProbeError('local_service_unreachable');};
    writeFileSync(join(f.dir,'supervisor-state.json'),JSON.stringify({...f.hint,phase:'starting'}));
    assert.equal((await getTrayStatus(f.dir,version,{call:fail})).state,'starting');
    writeFileSync(join(f.dir,'supervisor-state.json'),JSON.stringify({...f.hint,phase:'stopping'}));
    const stop=join(f.dir,'supervisor.stop');writeFileSync(stop,JSON.stringify({owner:f.hint.owner}));utimesSync(stop,new Date(Date.now()-60000),new Date(Date.now()-60000));
    assert.equal((await getTrayStatus(f.dir,version,{call:fail})).state,'stop_unconfirmed');
    unlinkSync(join(f.dir,'supervisor.lock'));unlinkSync(join(f.dir,'service.lock'));unlinkSync(stop);
    writeFileSync(join(f.dir,'supervisor-state.json'),JSON.stringify({...f.hint,phase:'stopping',cleanup_complete:true}));
    const stopped=await getTrayStatus(f.dir,version,{call:fail});assert.equal(stopped.state,'stopped');assert.equal(stopped.tone,'gray');assert.equal(stopped.control,'start');assert.equal(stopped.error,null);assert.equal(stopped.inflight_count,null);
    writeProductionConfig(f.dir,{...f.config,tunnel:undefined});const unconfiguredStopped=await getTrayStatus(f.dir,version,{call:fail});assert.equal(unconfiguredStopped.state,'stopped');assert.equal(unconfiguredStopped.cloud,'未检查');assert.equal(unconfiguredStopped.dot,'未检查');
  }finally{f.close();}
});

test('dead running owner enables explicit recovery only for service-not-running and proven gone recorded processes',async()=>{
  const f=fixture();try {
    const hint={...f.hint,pid:2147483000,bridge_pid:2147483001,guardian_pid:2147483002,tunnel_pid:2147483003};
    writeFileSync(join(f.dir,'supervisor-state.json'),JSON.stringify(hint));
    writeFileSync(join(f.dir,'supervisor.lock'),JSON.stringify({owner:hint.owner,pid:hint.pid}));
    writeFileSync(join(f.dir,'service.lock'),JSON.stringify({owner:'service-owner',pid:hint.bridge_pid}));
    const before=readFileSync(join(f.dir,'supervisor-state.json'),'utf8');
    const call=async()=>{throw new ProbeError('service_not_running');};
    const actual=await getTrayStatus(f.dir,version,{call});
    assert.equal(actual.state,'failed');assert.equal(actual.title,'后台连接中断');assert.equal(actual.control,'start');assert.equal(actual.error,'background_connection_lost');assert.equal(actual.inflight_count,null);assert.notEqual(actual.tone,'green');
    for(const presence of ['present','unknown'] as const) {
      const status=await getTrayStatus(f.dir,version,{call,processPresence:()=>presence});assert.equal(status.state,'unknown');assert.equal(status.control,'disabled');
    }
    const permissionDenied=await getTrayStatus(f.dir,version,{call,processPresence:()=>{throw Object.assign(new Error('no permission'),{code:'EPERM'});}});
    assert.equal(permissionDenied.control,'disabled');
    const unreachable=await getTrayStatus(f.dir,version,{call:async()=>{throw new ProbeError('local_service_unreachable');},processPresence:()=> 'gone'});
    assert.equal(unreachable.control,'disabled');
    writeFileSync(join(f.dir,'service.lock'),JSON.stringify({owner:'foreign-service',pid:process.pid}));
    assert.equal((await getTrayStatus(f.dir,version,{call,processPresence:()=> 'gone'})).control,'disabled');
    assert.equal(readFileSync(join(f.dir,'supervisor-state.json'),'utf8'),before);
  }finally{f.close();}
});

test('failed and unknown projections expose a recent safe startup reason without replacing current or newer service evidence',async()=>{
  const f=fixture();try {
    const now=Date.now()+10,code='supervisor_recovery_recovery_probe_failed';
    const record={schema:1,owner:'codex-dots-bridge-startup',mode:'autostart',outcome:'failed',events:[{at:new Date(now).toISOString(),stage:'finished',code}]};
    writeFileSync(startupDiagnosticPath(f.dir),JSON.stringify(record));
    const call=async()=>{throw new ProbeError('local_service_unreachable');};
    const unknown=await getTrayStatus(f.dir,version,{call,now:()=>now});
    assert.equal(unknown.state,'unknown');assert.equal(unknown.error,'local_service_unreachable');assert.equal(unknown.control,'disabled');assert.ok(unknown.reason.includes(code));assert.ok(unknown.reason.length<=180);
    const healthy=await getTrayStatus(f.dir,version,{call:async()=>ready,now:()=>now});
    assert.equal(healthy.state,'ready');assert.equal(healthy.reason.includes(code),false);
    utimesSync(join(f.dir,'supervisor-state.json'),new Date(now+1000),new Date(now+1000));
    assert.equal((await getTrayStatus(f.dir,version,{call,now:()=>now+1000})).reason.includes(code),false);
    record.events[0]!.code='PRIVATE/path\nbody';writeFileSync(startupDiagnosticPath(f.dir),JSON.stringify(record));
    assert.equal((await getTrayStatus(f.dir,version,{call,now:()=>now+1000})).reason.includes('PRIVATE'),false);
  }finally{f.close();}
});
test('actual productionCall uses caller authentication and enforces bounded tray timeout',async()=>{
  const f=fixture();let server:Server|undefined;
  try {
    writeFileSync(join(f.dir,'caller.key'),'a'.repeat(64));let hang=false,requests=0;
    server=createServer((request,response)=>{requests++;assert.equal(request.url,'/control/dots_status');assert.equal(request.headers.authorization,'Bearer '+readToken(f.dir,'caller'));if(hang)return;response.setHeader('content-type','application/json');response.end(JSON.stringify(ready));});
    await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
    writeProductionConfig(f.dir,{...f.config,endpoint:'http://127.0.0.1:'+address.port+'/'});
    assert.equal((await getTrayStatus(f.dir,version)).state,'ready');assert.equal(requests,1);
    hang=true;const began=performance.now();const timeout=await getTrayStatus(f.dir,version);assert.equal(timeout.state,'unknown');assert.equal(timeout.inflight_count,null);assert.ok(performance.now()-began<4500);
  }finally {server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));f.close();}
});
