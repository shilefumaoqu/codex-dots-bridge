import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tunnelRunArguments } from '../src/supervisor.js';
import { readProductionConfig } from '../src/runtime.js';

test('production Tunnel arguments add only the bounded wait and preserve worker, routing and health options',()=>{
  const dir=resolve('synthetic-data'),endpoint='http://127.0.0.1:12345/';
  const config={tunnel_id:'tunnel_fake',organization_id:'fake-org',client_path:'fake-client.exe',key_file:'fake.env'};
  const expected=['run','--control-plane.tunnel-id','tunnel_fake','--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--control-plane.organization-id','fake-org','--mcp.server-url','url=http://127.0.0.1:12345/mcp/dot,channel=main','--mcp.extra-headers',`X-Codex-Dots-Worker-Token: file:${join(dir,'worker.key')}`,'--health.listen-addr','127.0.0.1:0','--health.url-file',join(dir,'tunnel-health.url'),'--log.level','warn','--log.format','json'];
  for(const [override,effective] of [[undefined,30],[1,1],[7,7],[300,300]] as const) {
    const args=tunnelRunArguments(dir,endpoint,{...config,startup_wait_seconds:override});
    const position=args.indexOf('--mcp.startup-wait-timeout');assert.ok(position>0);assert.equal(args[position+1],effective+'s');
    args.splice(position,2);assert.deepEqual(args,expected);
  }
});

test('setup preserves the configured wait and client identity; invalid wait fails before registration',()=>{
  const root=mkdtempSync(join(tmpdir(),'dots wait config ')),dir=join(root,'data');
  const cli=(args:string[])=>spawnSync(process.execPath,['--import','tsx','src/main.ts','setup','--data-dir',dir,...args],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,CODEX_HOME:join(root,'fake-home')}});
  try {
    const first=cli(['--no-register','--tunnel-id','tunnel_fake','--organization-id','fake-org','--tunnel-client',join(root,'fake-v16.exe'),'--tunnel-env',join(root,'fake.env'),'--tunnel-startup-wait-seconds','7']);assert.equal(first.status,0,first.stdout+first.stderr);
    let config=readProductionConfig(dir);assert.equal(config.tunnel?.startup_wait_seconds,7);const client=config.tunnel?.client_path;
    const update=cli(['--no-register','--organization-id','fake-org-updated']);assert.equal(update.status,0,update.stdout+update.stderr);
    config=readProductionConfig(dir);assert.equal(config.tunnel?.startup_wait_seconds,7);assert.equal(config.tunnel?.client_path,client);
    const before=readFileSync(join(dir,'config.json'),'utf8');
    // A missing registration command would produce a different failure if the
    // invalid wait were checked after invoking the installer.
    const invalid=cli(['--tunnel-startup-wait-seconds','301','--codex-command',join(root,'never-executed.exe')]);
    assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stdout).error,'invalid_parameters');assert.equal(readFileSync(join(dir,'config.json'),'utf8'),before);
  }finally{rmSync(root,{recursive:true,force:true});}
});
