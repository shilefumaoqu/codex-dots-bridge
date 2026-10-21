import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProduction, writeProductionConfig } from '../src/runtime.js';
import { createAutostartEntry, type InstallManifest } from '../src/maintenance.js';
import { readTrayAutostart, setTrayAutostart } from '../src/tray-autostart.js';
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"dots tray autostart O'Brien $literal ")),dir=join(root,'data'),payload=join(root,'payload'),home=join(root,'home'),appdata=join(root,'appdata');
  mkdirSync(join(payload,'dist'),{recursive:true});const entry=join(payload,'dist','main.js');writeFileSync(entry,'synthetic fixture');writeFileSync(join(payload,'CodexDotsBridge.Tray.exe'),'synthetic fixture');
  const config=initProduction(dir);writeProductionConfig(dir,{...config,installation:{root:payload,node_path:process.execPath}});
  const previous=process.env.APPDATA;process.env.APPDATA=appdata;
  const manifest:InstallManifest={owner:'codex-dots-bridge',instance_id:config.instance_id,codex_home:home,codex_command:'synthetic codex',mcp:{name:'codex-dots-bridge',command:process.execPath,args:[entry,'stdio','--data-dir',dir]},skill:{path:join(home,'skills','codex-dots-bridge'),files:{'SKILL.md':'synthetic-hash'}}};
  const manifestPath=join(dir,'installation.json');writeFileSync(manifestPath,JSON.stringify(manifest));
  const path=createAutostartEntry(dir,manifest.mcp,true).path;
  return {root,dir,payload,manifest,manifestPath,path,close(){if(previous===undefined)delete process.env.APPDATA;else process.env.APPDATA=previous;rmSync(root,{recursive:true,force:true});}};
}
test('owned autostart enables two hidden independent launches, toggles live without touching service or tasks',{skip:process.platform!=='win32'},()=>{
  const f=fixture();try {
    const service='{"owner":"live-service","pid":'+process.pid+'}';writeFileSync(join(f.dir,'service.lock'),service);
    const config=readFileSync(join(f.dir,'config.json'),'utf8'),caller=readFileSync(join(f.dir,'caller.key'),'utf8');
    assert.equal(readTrayAutostart(f.dir),'disabled');
    assert.deepEqual(setTrayAutostart(f.dir,true),{schema:1,autostart:'enabled',verified:true});
    const content=readFileSync(f.path,'utf8');assert.equal(content.match(/shell.Run /g)?.length,2);assert.equal(content.match(/, 0, False/g)?.length,2);assert.ok(content.includes(' run ')||content.includes('""run""'));assert.ok(content.includes('--autostart'));assert.ok(content.includes('CodexDotsBridge.Tray.exe'));assert.ok(content.includes('--background'));
    assert.equal(readTrayAutostart(f.dir),'enabled');assert.deepEqual(setTrayAutostart(f.dir,false),{schema:1,autostart:'disabled',verified:true});
    assert.equal(existsSync(f.path),false);assert.equal(JSON.parse(readFileSync(f.manifestPath,'utf8')).autostart,undefined);
    assert.equal(readFileSync(join(f.dir,'config.json'),'utf8'),config);assert.equal(readFileSync(join(f.dir,'service.lock'),'utf8'),service);assert.equal(readFileSync(join(f.dir,'caller.key'),'utf8'),caller);
    setTrayAutostart(f.dir,false);assert.equal(readTrayAutostart(f.dir),'disabled');
  }finally{f.close();}
});
test('foreign and modified startup entries are preserved; legacy owned entry can migrate',{skip:process.platform!=='win32'},()=>{
  const f=fixture();try {
    mkdirSync(join(f.path,'..'),{recursive:true});writeFileSync(f.path,'foreign');const before=readFileSync(f.manifestPath,'utf8');
    assert.equal(readTrayAutostart(f.dir),'unknown');assert.throws(()=>setTrayAutostart(f.dir,true),/foreign_autostart_collision/);assert.throws(()=>setTrayAutostart(f.dir,false),/foreign_autostart_collision/);
    assert.equal(readFileSync(f.path,'utf8'),'foreign');assert.equal(readFileSync(f.manifestPath,'utf8'),before);
    const legacy='Set shell = CreateObject("WScript.Shell")\r\nshell.Run "legacy owned command", 0, False\r\n';
    writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,autostart:{path:f.path,content:legacy}}));writeFileSync(f.path,legacy);
    assert.equal(readTrayAutostart(f.dir),'enabled');setTrayAutostart(f.dir,true);assert.ok(readFileSync(f.path,'utf8').includes('CodexDotsBridge.Tray.exe'));
    writeFileSync(f.path,'modified');assert.throws(()=>setTrayAutostart(f.dir,false),/foreign_autostart_collision/);assert.equal(readFileSync(f.path,'utf8'),'modified');
  }finally{f.close();}
});
test('concurrent lock, missing tray and foreign installation fail without destructive write',{skip:process.platform!=='win32'},()=>{
  const f=fixture();try {
    mkdirSync(join(f.path,'..'),{recursive:true});const lock=join(f.path,'..','.CodexDotsBridge.autostart.lock');writeFileSync(lock,'another client');
    assert.throws(()=>setTrayAutostart(f.dir,true),/autostart_update_busy/);assert.equal(readFileSync(lock,'utf8'),'another client');unlinkSync(lock);
    unlinkSync(join(f.payload,'CodexDotsBridge.Tray.exe'));const before=readFileSync(f.manifestPath,'utf8');assert.throws(()=>setTrayAutostart(f.dir,true),/tray_executable_missing/);assert.equal(readFileSync(f.manifestPath,'utf8'),before);assert.equal(existsSync(f.path),false);
    writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,instance_id:'22222222-2222-4222-8222-222222222222'}));assert.throws(()=>setTrayAutostart(f.dir,false),/foreign_installation_manifest/);assert.equal(existsSync(f.path),false);
  }finally{f.close();}
});
test('failed manifest commit restores the previous startup choice',{skip:process.platform!=='win32'},()=>{
  const f=fixture();try {
    setTrayAutostart(f.dir,true);const before=readFileSync(f.manifestPath,'utf8'),content=readFileSync(f.path,'utf8');
    chmodSync(f.manifestPath,0o400);
    assert.throws(()=>setTrayAutostart(f.dir,false),/autostart_update_failed/);
    assert.equal(readFileSync(f.manifestPath,'utf8'),before);assert.equal(readFileSync(f.path,'utf8'),content);assert.equal(readTrayAutostart(f.dir),'enabled');
    assert.equal(existsSync(join(f.path,'..','.CodexDotsBridge.autostart.lock')),false);
  }finally{chmodSync(f.manifestPath,0o600);f.close();}
});
