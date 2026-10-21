import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initProduction, readProductionConfig, writeProductionConfig, readToken, init, protectProductionDirectory } from '../src/runtime.js';
import { backupData, restoreData, statusData, installCodex, uninstallCodex, resolveCodexNpmShim } from '../src/maintenance.js';
import { isolatedEnvironment, parseTunnelEnvironment, startSupervisor, stopSupervisor } from '../src/supervisor.js';
import { configureDesktopAccess } from '../src/desktop-conversation-settings.js';

if(process.env.CODEX_DOTS_REQUIRE_CODEX_TESTS==='1') {
  assert.equal(process.platform,'win32','Required Codex maintenance coverage needs Windows.');
  assert.ok(process.env.CODEX_DOTS_TEST_CODEX && existsSync(process.env.CODEX_DOTS_TEST_CODEX),
    'Required Codex maintenance coverage: CODEX_DOTS_TEST_CODEX must point to the real executable; refusing silently skipped installation tests.');
}

function cleanup(path:string) {assert.ok(resolve(path).startsWith(resolve(tmpdir())+sep));rmSync(path,{recursive:true,force:true});}
test('production data is separate from P0 and refuses foreign/P0 directories',()=>{
  const root=mkdtempSync(join(tmpdir(),'dots production '));try {
    const p0=join(root,'p0'),dir=join(root,"生产 O'Brien $literal");init(p0);const first=initProduction(dir);assert.equal(initProduction(dir).instance_id,first.instance_id);
    assert.throws(()=>initProduction(p0));assert.equal(JSON.parse(readFileSync(join(p0,'config.json'),'utf8')).owner,'codex-dots-bridge-p0');
    const foreign=join(root,'foreign');mkdirSync(foreign);writeFileSync(join(foreign,'preserve.txt'),'keep');assert.throws(()=>initProduction(foreign),/unowned_data_directory/);assert.equal(readFileSync(join(foreign,'preserve.txt'),'utf8'),'keep');
  }finally{cleanup(root);}
});
test('consistent SQLite backup includes recovery keys; restore remaps paths, preserves pending state, refuses overwrite and tampering',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots recovery '));let db:Database.Database|undefined;
  try {
    const dir=join(root,'data'),backup=join(root,'protected backup'),restored=join(root,'restored data');initProduction(dir);const config=readProductionConfig(dir);
    const secret=join(dir,'tunnel-runtime.env');writeFileSync(secret,'CONTROL_PLANE_API_KEY=synthetic_test_key');writeProductionConfig(dir,{...config,tunnel:{tunnel_id:'tunnel_test',organization_id:'org_test',client_path:process.execPath,key_file:secret}});
    db=new Database(join(dir,'tasks.sqlite'));db.pragma('journal_mode=WAL');db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE task_subscriptions(id TEXT PRIMARY KEY,data TEXT);');
    db.prepare('INSERT INTO tasks VALUES(?,?)').run('task-1',JSON.stringify({status:'waiting_input',body:'sensitive task text'}));
    db.prepare('INSERT INTO task_subscriptions VALUES(?,?)').run('sub-1',JSON.stringify({active:true,expires_at:Date.now()+60000}));
    const result=await backupData(dir,backup);assert.equal(result.consistent_sqlite,true);assert.equal(statusData(dir).tasks.waiting_input,1);assert.equal(statusData(dir).plugin_subscription,'active');assert.ok(!JSON.stringify(statusData(dir)).includes('sensitive task text'));
    restoreData(backup,restored);assert.equal(readToken(restored,'caller'),readToken(dir,'caller'));assert.equal(statusData(restored).tasks.waiting_input,1);assert.equal(readProductionConfig(restored).tunnel!.key_file,join(restored,'tunnel-runtime.env'));assert.equal(readFileSync(join(restored,'tunnel-runtime.env'),'utf8'),'CONTROL_PLANE_API_KEY=synthetic_test_key');
    assert.throws(()=>restoreData(backup,restored),/restore_destination_not_empty/);writeFileSync(join(backup,'caller.key'),'0'.repeat(64));assert.throws(()=>restoreData(backup,join(root,'tampered restore')),/backup_integrity_failed/);
    writeFileSync(join(restored,'service.lock'),JSON.stringify({pid:process.pid,owner:'test'}));assert.throws(()=>restoreData(backup,restored),/stop_service_first/);
  }finally{db?.close();cleanup(root);}
});
test('backup and restore reject overlapping paths including Windows case variants without changing source',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots overlap '));
  try {
    const dir=join(root,'data'),backup=join(root,'backup');initProduction(dir);
    const token=readToken(dir,'caller');
    for(const variant of process.platform==='win32'?[dir,dir.toUpperCase()]:[dir]) {
      await assert.rejects(()=>backupData(dir,join(variant,'nested')),/backup_path_conflict/);
      assert.ok(!existsSync(join(dir,'nested')));
      await assert.rejects(()=>backupData(dir,variant),/backup_path_conflict/);
    }
    await backupData(dir,backup);
    for(const variant of process.platform==='win32'?[backup,backup.toUpperCase()]:[backup]) {
      assert.throws(()=>restoreData(backup,join(variant,'nested')),/restore_path_conflict/);
      assert.ok(!existsSync(join(backup,'nested')));
    }
    protectProductionDirectory(dir);protectProductionDirectory(backup);
    assert.equal(readToken(dir,'caller'),token);assert.equal(readToken(backup,'caller'),token);
  }finally{cleanup(root);}
});

test('platform key is parsed only for Tunnel; bridge environment omits platform/worker/user secrets',()=>{
  const key='TEST_SECRET_ENV';process.env.CONTROL_PLANE_API_KEY=key;process.env.OPENAI_API_KEY=key;process.env.TEST_RANDOM_SECRET=key;
  try {assert.ok(!JSON.stringify(isolatedEnvironment()).includes(key));assert.deepEqual(parseTunnelEnvironment('# comment\r\nCONTROL_PLANE_API_KEY="synthetic"\r\n'),{CONTROL_PLANE_API_KEY:'synthetic'});for(const body of ['OPENAI_API_KEY=x','CONTROL_PLANE_API_KEY=x\nOTHER=y','CONTROL_PLANE_API_KEY=two words'])assert.throws(()=>parseTunnelEnvironment(body),/invalid_tunnel_key_file/);}finally{delete process.env.CONTROL_PLANE_API_KEY;delete process.env.OPENAI_API_KEY;delete process.env.TEST_RANDOM_SECRET;}
});
test('owned Codex MCP/Skill install is idempotent, preserves unrelated TOML and altered Skill', {skip:!process.env.CODEX_DOTS_TEST_CODEX},()=>{
  const root=mkdtempSync(join(tmpdir(),'dots installer '));try {
    const dir=join(root,'data'),home=join(root,'codex home'),source=join(root,'skill source');initProduction(dir);mkdirSync(home);mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'---\nname: codex-dots-bridge\ndescription: test\n---\n');
    const unrelated='approval_policy = "on-request"\n\n[mcp_servers.unrelated]\ncommand = "preserve-command"\nargs = ["literal space"]\n';writeFileSync(join(home,'config.toml'),unrelated);
    const entry=join(root,'synthetic main.mjs');writeFileSync(entry,'// synthetic installation entry');
    const options={nodePath:process.execPath,entryPath:entry,skillSource:source,codexHome:home,codexCommand:process.env.CODEX_DOTS_TEST_CODEX!};
    assert.equal(installCodex(dir,options).mcp,'registered');unlinkSync(join(home,'skills','codex-dots-bridge','SKILL.md'));assert.equal(installCodex(dir,options).mcp,'registered');assert.equal(readFileSync(join(home,'skills','codex-dots-bridge','SKILL.md'),'utf8'),readFileSync(join(source,'SKILL.md'),'utf8'));const toml=readFileSync(join(home,'config.toml'),'utf8');assert.ok(toml.includes('approval_policy = "on-request"'));assert.ok(toml.includes('preserve-command'));assert.ok(toml.includes('literal space'));
    writeFileSync(join(home,'skills','codex-dots-bridge','SKILL.md'),'user modified');const result=uninstallCodex(dir);assert.ok(result.removed.includes('mcp'));assert.ok(result.retained.includes('modified_or_foreign_skill'));assert.equal(readFileSync(join(home,'skills','codex-dots-bridge','SKILL.md'),'utf8'),'user modified');assert.ok(existsSync(join(dir,'caller.key')));
  }finally{cleanup(root);}
});

test('real Codex CLI installs into a new nested CODEX_HOME and uninstalls without losing data',{skip:!process.env.CODEX_DOTS_TEST_CODEX},()=>{
  const root=mkdtempSync(join(tmpdir(),'dots new home '));try {
    const dir=join(root,'data'),home=join(root,'new nested','codex home'),source=join(root,'skill'),entry=join(root,'main.mjs');
    initProduction(dir);mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'owned synthetic skill');writeFileSync(entry,'// synthetic entry');
    assert.ok(!existsSync(home));
    assert.equal(installCodex(dir,{nodePath:process.execPath,entryPath:entry,skillSource:source,codexHome:home,codexCommand:process.env.CODEX_DOTS_TEST_CODEX!}).mcp,'registered');
    assert.ok(existsSync(join(home,'config.toml')));assert.ok(uninstallCodex(dir).removed.includes('mcp'));assert.ok(existsSync(join(dir,'caller.key')));
  }finally{cleanup(root);}
});

test('failed setup registration preserves installation, Tunnel and desktop access settings',{skip:!process.env.CODEX_DOTS_TEST_CODEX},()=>{
  const root=mkdtempSync(join(tmpdir(),'dots setup failure '));try {
    for(const failure of ['foreign','owned-change','cli'] as const) {
      const fixture=join(root,failure),dir=join(fixture,'data'),home=join(fixture,'codex home'),source=join(fixture,'skill'),entry=join(fixture,'old main.mjs');
      initProduction(dir);mkdirSync(home);mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'owned synthetic skill');writeFileSync(entry,'// prior entry');
      const config=readProductionConfig(dir);writeProductionConfig(dir,{...config,installation:{root:fixture,node_path:process.execPath},tunnel:{tunnel_id:'tunnel_original',organization_id:'original-org',client_path:process.execPath,key_file:join(dir,'tunnel-runtime.env')}});
      configureDesktopAccess(dir,'read-send',home);
      const cli=process.env.CODEX_DOTS_TEST_CODEX!;
      if(failure==='owned-change')installCodex(dir,{nodePath:process.execPath,entryPath:entry,skillSource:source,codexHome:home,codexCommand:cli});
      else writeFileSync(join(home,'config.toml'),failure==='foreign'?'approval_policy = "on-request"\n[mcp_servers.codex-dots-bridge]\ncommand = "foreign-command"\nargs = []\n':'approval_policy = "on-request"\n');
      const before=Object.fromEntries(['config.json','desktop-conversations.json'].map(name=>[name,readFileSync(join(dir,name),'utf8')])),toml=readFileSync(join(home,'config.toml'),'utf8');
      const result=spawnSync(process.execPath,[resolve('dist/main.js'),'setup','--data-dir',dir,'--codex-home',home,'--codex-command',failure==='cli'?join(fixture,'missing codex.exe'):cli,'--desktop-access','off','--tunnel-id','tunnel_replacement'],{encoding:'utf8',windowsHide:true,timeout:30000});
      assert.equal(result.status,1);assert.match(result.stdout,new RegExp(failure==='foreign'?'foreign_mcp_collision':failure==='owned-change'?'installation_change_requires_uninstall':'codex_cli_operation_failed'));
      for(const [name,text] of Object.entries(before))assert.equal(readFileSync(join(dir,name),'utf8'),text);
      assert.equal(readFileSync(join(home,'config.toml'),'utf8'),toml);
    }
  }finally{cleanup(root);}
});

test('setup validates connection settings and stopped state before registration',{skip:!process.env.CODEX_DOTS_TEST_CODEX},()=>{
  const root=mkdtempSync(join(tmpdir(),'dots setup preflight '));try {
    for(const failure of ['access','home','configuration','running','tunnel'] as const) {
      const fixture=join(root,failure),dir=join(fixture,'data'),home=join(fixture,'codex home');initProduction(dir);mkdirSync(home);
      writeFileSync(join(home,'config.toml'),'approval_policy = "on-request"\n');
      if(failure==='configuration')writeFileSync(join(dir,'desktop-conversations.json'),'{}');
      if(failure==='running')writeFileSync(join(dir,'service.lock'),JSON.stringify({pid:process.pid}));
      const before=readFileSync(join(dir,'config.json'),'utf8');
      const tunnelArgs=failure==='tunnel'?['--tunnel-id','invalid','--organization-id','fixture-org','--tunnel-client',process.execPath,'--tunnel-env',join(dir,'tunnel-runtime.env')]:[];
      const result=spawnSync(process.execPath,[resolve('dist/main.js'),'setup','--data-dir',dir,'--codex-home',failure==='home'?join(fixture,'missing home'):home,'--codex-command',process.env.CODEX_DOTS_TEST_CODEX!,'--desktop-access',failure==='access'?'invalid':'read',...tunnelArgs],{encoding:'utf8',windowsHide:true,timeout:30000});
      assert.equal(result.status,1);assert.match(result.stdout,new RegExp({access:'invalid_desktop_access',home:'codex_home_unavailable',configuration:'invalid_desktop_configuration',running:'stop_service_first',tunnel:'invalid_parameters'}[failure]));
      assert.equal(readFileSync(join(dir,'config.json'),'utf8'),before);assert.ok(!existsSync(join(dir,'installation.json')));
      assert.equal(readFileSync(join(home,'config.toml'),'utf8'),'approval_policy = "on-request"\n');
    }
  }finally{cleanup(root);}
});
test('setup without autostart flag preserves a user-modified owned startup script',{skip:process.platform!=='win32'||!process.env.CODEX_DOTS_TEST_CODEX},()=>{
  const root=mkdtempSync(join(tmpdir(),'dots startup ownership ')),priorAppData=process.env.APPDATA;
  try {
    process.env.APPDATA=join(root,'appdata');
    const dir=join(root,'data'),home=join(root,'codex home'),source=join(root,'skill'),entry=join(root,'main.mjs');
    initProduction(dir);mkdirSync(home);mkdirSync(source);writeFileSync(entry,'// fixture');writeFileSync(join(source,'SKILL.md'),'---\nname: codex-dots-bridge\ndescription: test\n---\n');
    const options={nodePath:process.execPath,entryPath:entry,skillSource:source,codexHome:home,codexCommand:process.env.CODEX_DOTS_TEST_CODEX!,autostart:true};
    installCodex(dir,options);const manifest=JSON.parse(readFileSync(join(dir,'installation.json'),'utf8'));
    const changed='user-owned customization';writeFileSync(manifest.autostart.path,changed);
    assert.throws(()=>installCodex(dir,{...options,autostart:undefined}),/foreign_autostart_collision/);
    assert.equal(readFileSync(manifest.autostart.path,'utf8'),changed);
    assert.ok(uninstallCodex(dir).retained.includes('modified_or_foreign_autostart'));
    assert.equal(readFileSync(manifest.autostart.path,'utf8'),changed);
  }finally{if(priorAppData===undefined)delete process.env.APPDATA;else process.env.APPDATA=priorAppData;cleanup(root);}
});

test('setup upgrades an owned legacy startup after adding the tray and still preserves foreign edits',{skip:process.platform!=='win32'||!process.env.CODEX_DOTS_TEST_CODEX},()=>{
  const root=mkdtempSync(join(tmpdir(),'dots startup tray upgrade ')),priorAppData=process.env.APPDATA;
  try {
    process.env.APPDATA=join(root,'appdata');
    const dir=join(root,'data'),home=join(root,'codex home'),source=join(root,'skill'),entry=join(root,'payload','dist','main.js');
    initProduction(dir);mkdirSync(home);mkdirSync(source);mkdirSync(join(entry,'..'),{recursive:true});
    writeFileSync(entry,'// synthetic entry');writeFileSync(join(source,'SKILL.md'),'owned synthetic skill');
    const options={nodePath:process.execPath,entryPath:entry,skillSource:source,codexHome:home,codexCommand:process.env.CODEX_DOTS_TEST_CODEX!,autostart:true};
    installCodex(dir,options);
    const manifestPath=join(dir,'installation.json'),legacy=JSON.parse(readFileSync(manifestPath,'utf8'));
    assert.ok(!legacy.autostart.content.includes('CodexDotsBridge.Tray.exe'));
    writeFileSync(join(root,'payload','CodexDotsBridge.Tray.exe'),'synthetic tray file; never executed');
    installCodex(dir,options);
    const current=JSON.parse(readFileSync(manifestPath,'utf8'));
    assert.ok(current.autostart.content.includes('CodexDotsBridge.Tray.exe'));
    assert.equal(readFileSync(current.autostart.path,'utf8'),current.autostart.content);
    installCodex(dir,options);
    const changed='user-owned customization';writeFileSync(current.autostart.path,changed);
    assert.throws(()=>installCodex(dir,options),/foreign_autostart_collision/);
    assert.equal(readFileSync(current.autostart.path,'utf8'),changed);
    assert.equal(readFileSync(manifestPath,'utf8'),JSON.stringify(current,null,2));
  }finally{if(priorAppData===undefined)delete process.env.APPDATA;else process.env.APPDATA=priorAppData;cleanup(root);}
});

test('legacy Startup ownership survives failed MCP readback and failed replacement manifest write',{skip:process.platform!=='win32'||!process.env.CODEX_DOTS_TEST_CODEX},()=>{
  const root=mkdtempSync(join(tmpdir(),'dots startup migration failure ')),priorAppData=process.env.APPDATA;
  try {
    process.env.APPDATA=join(root,'appdata');
    const dir=join(root,'data'),home=join(root,'codex home'),source=join(root,'skill'),entry=join(root,'payload','dist','main.js');
    initProduction(dir);mkdirSync(home);mkdirSync(source);mkdirSync(join(entry,'..'),{recursive:true});
    writeFileSync(entry,'// synthetic entry');writeFileSync(join(source,'SKILL.md'),'owned synthetic skill');
    const command=process.env.CODEX_DOTS_TEST_CODEX!;
    const options={nodePath:process.execPath,entryPath:entry,skillSource:source,codexHome:home,codexCommand:command,autostart:true};
    installCodex(dir,options);
    const manifestPath=join(dir,'installation.json'),original=readFileSync(manifestPath,'utf8'),legacy=JSON.parse(original);
    writeFileSync(join(root,'payload','CodexDotsBridge.Tray.exe'),'synthetic tray file; never executed');
    const actualExec=childProcess.execFileSync;let lists=0;
    const readback=mock.method(childProcess,'execFileSync',((executable:unknown,args:unknown,...rest:unknown[])=>{
      if(executable===command&&Array.isArray(args)&&args[0]==='mcp'&&args[1]==='list'&&++lists===2)throw new Error('synthetic MCP readback failure');
      return (actualExec as Function)(executable,args,...rest);
    }) as typeof actualExec);
    syncBuiltinESMExports();
    try{assert.throws(()=>installCodex(dir,options),/codex_cli_operation_failed/);}finally{readback.mock.restore();syncBuiltinESMExports();}
    assert.equal(readFileSync(manifestPath,'utf8'),original);assert.equal(readFileSync(legacy.autostart.path,'utf8'),legacy.autostart.content);
    const actualWrite=fs.writeFileSync;let injected=false;
    const commit=mock.method(fs,'writeFileSync',((path:unknown,data:unknown,...rest:unknown[])=>{
      if(path===manifestPath&&typeof data==='string'&&data.includes('CodexDotsBridge.Tray.exe')&&!injected){injected=true;throw new Error('synthetic manifest commit failure');}
      return (actualWrite as Function)(path,data,...rest);
    }) as typeof actualWrite);
    syncBuiltinESMExports();
    try{assert.throws(()=>installCodex(dir,options),/synthetic manifest commit failure/);}finally{commit.mock.restore();syncBuiltinESMExports();}
    assert.equal(injected,true);assert.equal(readFileSync(manifestPath,'utf8'),original);assert.equal(readFileSync(legacy.autostart.path,'utf8'),legacy.autostart.content);
    installCodex(dir,options);
    const updated=JSON.parse(readFileSync(manifestPath,'utf8'));assert.equal(readFileSync(updated.autostart.path,'utf8'),updated.autostart.content);assert.ok(updated.autostart.content.includes('CodexDotsBridge.Tray.exe'));
    assert.ok(uninstallCodex(dir).removed.includes('autostart'));
  }finally{mock.restoreAll();syncBuiltinESMExports();if(priorAppData===undefined)delete process.env.APPDATA;else process.env.APPDATA=priorAppData;cleanup(root);}
});

test('hidden supervisor owns one bridge, rejects duplicate and stops without task cancellation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots supervisor ')),dir=join(root,'data'),entry=join(root,'synthetic main.mjs');initProduction(dir);
  const moduleURL=pathToFileURL(resolve('dist/supervisor.js')).href;
  writeFileSync(entry,`import { readFileSync,writeFileSync,unlinkSync } from 'node:fs'; import { join } from 'node:path'; import {createServer} from 'node:http'; const args=process.argv.slice(2),dir=args[args.indexOf('--data-dir')+1]; if(args.includes('--supervisor')) {const {runSupervisor}=await import(${JSON.stringify(moduleURL)}); await runSupervisor(dir,{nodePath:process.execPath,entryPath:process.argv[1]});} else { const server=createServer((_,res)=>res.end('test'));server.listen(0,'127.0.0.1',()=>{const config=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));config.endpoint='http://127.0.0.1:'+server.address().port+'/';writeFileSync(join(dir,'service.lock'),JSON.stringify({pid:process.pid,owner:'synthetic'}));writeFileSync(join(dir,'config.json'),JSON.stringify(config));process.send?.({type:'bridge_ready',endpoint:config.endpoint});});process.on('message',m=>{if(m.type==='shutdown')server.close(()=>{unlinkSync(join(dir,'service.lock'));process.disconnect();});});}`);
  try {
    const options={nodePath:process.execPath,entryPath:entry};const started=await startSupervisor(dir,options);assert.equal(started.supervisor,'running');assert.equal(started.bridge,'running');assert.equal(started.tunnel,'stopped');assert.ok(readProductionConfig(dir).endpoint);await assert.rejects(()=>startSupervisor(dir,options),/supervisor_already_running|supervisor_recovery_endpoint_active_or_unknown|supervisor_recovery_same_data_process_active/);const stopped=await stopSupervisor(dir);assert.equal(stopped.dot_tasks,'not_cancelled');assert.ok(!existsSync(join(dir,'service.lock')));assert.ok(!existsSync(join(dir,'supervisor.lock')));
  }finally{try{await stopSupervisor(dir);}catch{}cleanup(root);}
});
test('foreign MCP collision is preserved; changed owned registration is retained during uninstall',{skip:!process.env.CODEX_DOTS_TEST_CODEX},()=>{
  const root=mkdtempSync(join(tmpdir(),'dots mcp collision '));try {
    const dir=join(root,'data'),home=join(root,'codex home'),source=join(root,'skill source'),entry=join(root,'main.mjs');initProduction(dir);mkdirSync(home);mkdirSync(source);writeFileSync(entry,'// fixture');writeFileSync(join(source,'SKILL.md'),'---\nname: codex-dots-bridge\ndescription: fixture\n---\n');
    const path=join(home,'config.toml'),foreign='[mcp_servers.codex-dots-bridge]\ncommand = "foreign-command"\nargs = []\n';writeFileSync(path,foreign);
    const options={nodePath:process.execPath,entryPath:entry,skillSource:source,codexHome:home,codexCommand:process.env.CODEX_DOTS_TEST_CODEX!};
    assert.throws(()=>installCodex(dir,options),/foreign_mcp_collision/);assert.equal(readFileSync(path,'utf8'),foreign);assert.ok(!existsSync(join(dir,'installation.json')));
    writeFileSync(path,'');installCodex(dir,options);writeFileSync(path,readFileSync(path,'utf8').replace('[mcp_servers.codex-dots-bridge]','[mcp_servers.codex-dots-bridge]\nenabled = false'));
    const result=uninstallCodex(dir);assert.ok(result.retained.includes('modified_or_foreign_mcp'));assert.ok(readFileSync(path,'utf8').includes('enabled = false'));
  }finally{cleanup(root);}
});
test('compiled production main starts a real isolated control service and restarts with persisted data',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dots real main ')),dir=join(root,'data');initProduction(dir);const options={nodePath:process.execPath,entryPath:resolve('dist/main.js')};
  try {
    for(let attempt=0;attempt<2;attempt++) {
      const started=await startSupervisor(dir,options);assert.equal(started.supervisor,'running');
      const response=await fetch(new URL('control/dots_status',readProductionConfig(dir).endpoint!),{method:'POST',headers:{authorization:'Bearer '+readToken(dir,'caller'),'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)});
      assert.equal(response.status,200);assert.ok(existsSync(join(dir,'tasks.sqlite')));await stopSupervisor(dir);assert.ok(!existsSync(join(dir,'service.lock')));
    }
  }finally{try{await stopSupervisor(dir);}catch{}cleanup(root);}
});

test('npm CLI discovery resolves supported native layouts without executing the command shim',()=>{
  const root=mkdtempSync(join(tmpdir(),'dots npm cli discovery '));
  try {
    const shim=join(root,'codex.cmd');writeFileSync(shim,'@echo never execute a shell wrapper');
    assert.throws(()=>resolveCodexNpmShim(shim),/official_codex_cli_missing/);
    for(const layout of [
      ['node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'],
      ['node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'],
      ['node_modules','@openai','codex','vendor','x86_64-pc-windows-msvc','bin','codex.exe'],
      ['node_modules','@openai','codex','vendor','x86_64-pc-windows-msvc','codex','codex.exe'],
    ]) { const exe=join(root,...layout);mkdirSync(join(exe,'..'),{recursive:true});writeFileSync(exe,'synthetic native file');assert.equal(resolveCodexNpmShim(shim),exe);unlinkSync(exe); }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('explicit replacement Codex CLI removes only the owned registration when the old desktop executable is gone',{skip:!process.env.CODEX_DOTS_TEST_CODEX},()=>{
  const root=mkdtempSync(join(tmpdir(),'dots cli upgrade '));
  try {
    const dir=join(root,'data'),home=join(root,'codex home'),source=join(root,'skill source'),entry=join(root,'main.mjs');
    initProduction(dir);mkdirSync(home);mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'owned synthetic skill');writeFileSync(entry,'// synthetic main');
    writeFileSync(join(home,'config.toml'),'[mcp_servers.unrelated]\ncommand="preserve"\n');
    const db=new Database(join(dir,'tasks.sqlite'));db.exec("CREATE TABLE synthetic_preserved (value TEXT); INSERT INTO synthetic_preserved VALUES ('release smoke')");db.close();
    installCodex(dir,{nodePath:process.execPath,entryPath:entry,skillSource:source,codexHome:home,codexCommand:process.env.CODEX_DOTS_TEST_CODEX!});
    const manifestPath=join(dir,'installation.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));manifest.codex_command=join(root,'removed desktop','codex.exe');writeFileSync(manifestPath,JSON.stringify(manifest));
    assert.throws(()=>uninstallCodex(dir),/codex_cli_operation_failed/);
    const result=uninstallCodex(dir,process.env.CODEX_DOTS_TEST_CODEX);assert.ok(result.removed.includes('mcp'));assert.ok(result.retained.includes('task_data'));
    assert.match(readFileSync(join(home,'config.toml'),'utf8'),/command = "preserve"/);assert.ok(existsSync(join(dir,'tasks.sqlite')));const preserved=new Database(join(dir,'tasks.sqlite'),{readonly:true});try{assert.deepEqual(preserved.prepare('SELECT value FROM synthetic_preserved').all(),[{value:'release smoke'}]);}finally{preserved.close();}
  }finally{cleanup(root);}
});
