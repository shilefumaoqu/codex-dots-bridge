import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTrayAutostartAsync } from '../src/tray-autostart.js';

test('service Startup inspection uses bounded asynchronous execFile and keeps lifecycle sync calls out',async t=>{
  const root=mkdtempSync(join(tmpdir(),'dots async startup ')),app=join(root,'app'),payload=join(app,'payload','0.3.0-alpha.1'),dir=join(root,'data'),home=join(root,'home');
  const launcher=join(app,'CodexDotsBridge.Launcher.exe'),launcherBody='trusted synthetic launcher',instance='11111111-1111-4111-8111-111111111111';
  mkdirSync(join(payload,'dist'),{recursive:true});mkdirSync(dir);mkdirSync(home);
  writeFileSync(launcher,launcherBody);
  writeFileSync(join(app,'installation-state.json'),JSON.stringify({owner:'codex-dots-bridge-setup',schema:1,install_directory:app,launcher_sha256:createHash('sha256').update(launcherBody).digest('hex')}));
  writeFileSync(join(dir,'config.json'),JSON.stringify({owner:'codex-dots-bridge',schema_version:1,instance_id:instance,installation:{root:payload,node_path:process.execPath}}));
  writeFileSync(join(dir,'installation.json'),JSON.stringify({owner:'codex-dots-bridge',instance_id:instance,codex_home:home,mcp:{name:'codex-dots-bridge',command:process.execPath,args:[join(payload,'dist','main.js'),'stdio','--data-dir',dir]},skill:{path:join(home,'skills','codex-dots-bridge'),files:{}},autostart_launcher:launcher}));
  const platform=Object.getOwnPropertyDescriptor(process,'platform')!,appdata=process.env.APPDATA;
  Object.defineProperty(process,'platform',{...platform,value:'win32'});process.env.APPDATA=join(root,'appdata');
  let callback!:(error:Error|null,stdout:string,stderr:string)=>void,options:any,calls=0;
  t.mock.method(childProcess,'execFileSync',()=>assert.fail('status must not execute a blocking subprocess'));
  t.mock.method(childProcess,'execFile',((file:string,args:string[],settings:any,done:typeof callback)=>{assert.equal(file,launcher);assert.deepEqual(args,['--startup','inspect']);options=settings;callback=done;calls++;return {} as any;}) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    let settled=false;const pending=readTrayAutostartAsync(dir).then(value=>{settled=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);assert.equal(calls,1);assert.equal(options.timeout,2500);assert.equal(options.maxBuffer,64*1024);assert.equal(options.windowsHide,true);
    callback(null,JSON.stringify({schema:1,path:join(process.env.APPDATA!,'Microsoft','Windows','Start Menu','Programs','Startup','CodexDotsBridge.lnk'),exists:false,owned:true,content:null,windows:'enabled',legacy_windows:'enabled'}),'');
    assert.equal(await pending,'disabled');
    const failure=readTrayAutostartAsync(dir);callback(Error('timeout'),'', 'PRIVATE_NATIVE_DETAILS');assert.equal(await failure,'unknown');
  }finally{
    t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,'platform',platform);
    if(appdata===undefined)delete process.env.APPDATA;else process.env.APPDATA=appdata;
    rmSync(root,{recursive:true,force:true});
  }
});
