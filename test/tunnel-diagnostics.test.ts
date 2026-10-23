import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionDiagnosticsData } from '../src/maintenance.js';
import { readProductionConfig, writeProductionConfig } from '../src/runtime.js';

function health(state:string,ready:boolean) {
  return {schema_version:1,live:true,ready,components:{mcp:{status:'unknown',state:'not_observed',details:{channel:'main',transport:'http-streamable',initialize:{ok:false},startup_probe:{state},server_discover:{ok:state==='succeeded'},PRIVATE_SECRET:'not forwarded'}},oauth:{state:'not_advertised'},harpoon:{state:'settled'}}};
}
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'dots health snapshot '));
  writeProductionConfig(dir,{owner:'codex-dots-bridge',schema_version:1,instance_id:'11111111-1111-4111-8111-111111111111',tunnel:{tunnel_id:'tunnel_fake',organization_id:'fake',client_path:'PRIVATE_CLIENT',key_file:'PRIVATE_KEY'}});
  let readyCode=200,payload:unknown=health('succeeded',true),healthCode=200,hang=false;
  const requests:string[]=[];
  const server=createServer((request,response)=>{
    requests.push(request.method+' '+request.url);
    if(hang)return;
    if(request.url==='/readyz'){response.statusCode=readyCode;response.end('PRIVATE_SECRET');return;}
    if(request.url==='/health/mcp'){const full=payload as ReturnType<typeof health>;response.setHeader('content-type','application/json');response.end(JSON.stringify({schema_version:1,component:'mcp',...full.components.mcp}));return;}
    response.statusCode=healthCode;response.setHeader('content-type','application/json');response.end(JSON.stringify(payload));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const address=server.address();assert.ok(address&&typeof address==='object');
  writeFileSync(join(dir,'tunnel-health.url'),`http://127.0.0.1:${address.port}/`);
  return {dir,requests,change(options:{readyCode?:number;payload?:unknown;healthCode?:number;hang?:boolean}){({readyCode=readyCode,payload=payload,healthCode=healthCode,hang=hang}=options);},async close(){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(dir,{recursive:true,force:true});}};
}

test('health snapshots preserve readyz semantics while distinguishing startup, auth and failure without MCP calls',async()=>{
  const f=await fixture();try {
    for(const [probe,readyCode,state,reason] of [
      ['succeeded',200,'ready','startup_ready'],['pending',503,'starting','startup_pending'],
      ['auth_required',200,'auth_required','auth_required'],['failed',503,'failed','startup_failed'],
      ['timed_out',200,'failed','startup_timeout'],['unrecognized',200,'unknown','startup_unconfirmed'],
      ['pending',200,'unknown','health_conflict'],['succeeded',503,'unknown','health_conflict'],
    ] as const) {
      f.change({readyCode,payload:health(probe,readyCode===200)});
      const actual=await connectionDiagnosticsData(f.dir);
      assert.equal(actual.tunnel_health,readyCode===200?'ready':'not_ready');assert.equal(actual.tunnel_connection,state);assert.equal(actual.tunnel_connection_reason,reason);
      assert.ok(!Number.isNaN(Date.parse(actual.tunnel_checked_at)));assert.ok(!JSON.stringify(actual).includes('PRIVATE'));
    }
    assert.ok(f.requests.every(route=>['GET /readyz','GET /health?details=true'].includes(route)));
  }finally{await f.close();}
});
test('terminal OAuth and catalog failures override auth hints while preserving specific startup failures',async()=>{
  const f=await fixture();try {
    for(const component of ['oauth','harpoon'] as const) {
      for(const [probe,reason] of [['auth_required','component_failed'],['failed','startup_failed'],['timed_out','startup_timeout']] as const) {
        const payload=health(probe,false);payload.components[component].state='failed';f.change({readyCode:503,payload});
        const actual=await connectionDiagnosticsData(f.dir);
        assert.equal(actual.tunnel_health,'not_ready');assert.equal(actual.tunnel_connection,'failed');assert.equal(actual.tunnel_connection_reason,reason);
      }
    }
  }finally{await f.close();}
});
test('unsupported, incomplete and conflicting health cannot imply ready; component fallback stays read only',async()=>{
  const f=await fixture();try {
    for(const payload of [{...health('succeeded',true),schema_version:2},{schema_version:1,ready:true},'PRIVATE_TEXT',health('succeeded',false)]) {
      f.change({payload});assert.equal((await connectionDiagnosticsData(f.dir)).tunnel_connection,'unknown');
    }
    const failed=health('succeeded',true);failed.components.oauth.state='failed';f.change({payload:failed});assert.equal((await connectionDiagnosticsData(f.dir)).tunnel_connection,'failed');
    f.change({healthCode:404,payload:health('succeeded',true)});assert.equal((await connectionDiagnosticsData(f.dir)).tunnel_connection,'ready');assert.ok(f.requests.includes('GET /health/mcp'));
    f.change({healthCode:200,payload:health('succeeded',true),hang:true});const begin=performance.now();const timed=await connectionDiagnosticsData(f.dir);assert.equal(timed.tunnel_connection,'unknown');assert.equal(timed.tunnel_health,'unreachable');assert.ok(performance.now()-begin<1900);
  }finally{await f.close();}
});
test('health endpoint validation and bounded configuration preserve existing client paths',async()=>{
  const f=await fixture();try {
    for(const url of ['https://127.0.0.1:8080/','http://localhost:8080/','http://127.0.0.1:8080/path','http://127.0.0.1:8080/?query=x','http://user@127.0.0.1:8080/','http://127.0.0.1:8080/#fragment']) {
      writeFileSync(join(f.dir,'tunnel-health.url'),url);await assert.rejects(()=>connectionDiagnosticsData(f.dir),/invalid_tunnel_health_endpoint/);
    }
    const config=readProductionConfig(f.dir);assert.equal(config.tunnel?.startup_wait_seconds,undefined);
    for(const value of [1,30,300]){writeProductionConfig(f.dir,{...config,tunnel:{...config.tunnel!,startup_wait_seconds:value}});assert.equal(readProductionConfig(f.dir).tunnel?.startup_wait_seconds,value);assert.equal(readProductionConfig(f.dir).tunnel?.client_path,'PRIVATE_CLIENT');}
    for(const value of [0,301,-1,1.5])assert.throws(()=>writeProductionConfig(f.dir,{...config,tunnel:{...config.tunnel!,startup_wait_seconds:value}}));
  }finally{await f.close();}
});
