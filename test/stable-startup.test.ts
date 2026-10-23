import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { initProduction, writeProductionConfig } from '../src/runtime.js';
import { installCodex, uninstallCodex, type InstallManifest } from '../src/maintenance.js';
import { inspectStartupLink, startupPath } from '../src/startup-link.js';
import { readTrayAutostart, setTrayAutostart as setNativeTrayAutostart } from '../src/tray-autostart.js';

const enabled=process.platform==='win32';
const build=enabled?mkdtempSync(join(tmpdir(),'dots launcher build ')):'';
if(enabled)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/build-launcher.ps1'),'-OutputDirectory',build],{windowsHide:true,stdio:'pipe'});
const binary=join(build,'CodexDotsBridge.Launcher.exe');
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
let launcherFailureDiagnosed=false;
function setTrayAutostart(dir:string,enable:boolean) {
  try{return setNativeTrayAutostart(dir,enable);}
  catch(error) {
    if(!launcherFailureDiagnosed&&(error as {code?:string}).code==='launcher_operation_failed') {
      launcherFailureDiagnosed=true;
      // Only this synthetic fixture is retried through reflection, so the real
      // Launcher exposes the exception its production receipt intentionally hides.
      try {
      const launcher=JSON.parse(readFileSync(join(dir,'installation.json'),'utf8')).autostart_launcher;
      const probe=String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$assembly=[Reflection.Assembly]::LoadFile($env:DOTS_TEST_LAUNCHER)
$method=$assembly.GetType('CodexDotsBridge.Launcher.Program').GetMethod('StartupCommand',[Reflection.BindingFlags]'NonPublic,Static')
try{$null=$method.Invoke($null,@('enable',$null));@{result='reflection_enable_passed'}|ConvertTo-Json -Compress}
catch{$chain=@();$exception=$_.Exception;while($exception){$chain+=@{type=$exception.GetType().FullName;hresult=$exception.HResult;message=$exception.Message};$exception=$exception.InnerException};@{result='reflection_enable_failed';session=[Diagnostics.Process]::GetCurrentProcess().SessionId;apartment=[Threading.Thread]::CurrentThread.ApartmentState.ToString();exceptions=$chain}|ConvertTo-Json -Compress -Depth 5}`;
      console.error('Launcher synthetic failure detail: '+execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(probe,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,DOTS_TEST_LAUNCHER:launcher}}).trim());}
      catch(probeError){console.error('Launcher synthetic diagnostic failed: '+String(probeError));}
    }
    throw error;
  }
}
function fixture(inspectUnicode=false){
  const base=mkdtempSync(join(tmpdir(),"dots stable 中文"+(inspectUnicode?'ع😀':'')+" O'Brien $literal ")),root=join(base,'app'),payload=join(root,'payload','0.2.0-alpha.24'),dir=join(base,'data'),appdata=join(base,'appdata'),home=join(base,'home');
  mkdirSync(join(payload,'dist'),{recursive:true});mkdirSync(join(payload,'skills','codex-dots-bridge'),{recursive:true});mkdirSync(home,{recursive:true});
  writeFileSync(join(payload,'dist','main.js'),'synthetic never executed');writeFileSync(join(payload,'package.json'),JSON.stringify({name:'codex-dots-bridge',version:'0.2.0-alpha.24'}));writeFileSync(join(payload,'skills','codex-dots-bridge','SKILL.md'),'old skill');
  const launcher=join(root,'CodexDotsBridge.Launcher.exe');copyFileSync(binary,launcher);
  const config=initProduction(dir);writeProductionConfig(dir,{...config,installation:{root:payload,node_path:process.execPath}});
  const state={owner:'codex-dots-bridge-setup',schema:1,install_directory:root,installer_app_id:'CodexDotsBridgeSetup',version:'0.2.0-alpha.24',payload_root:payload,data_dir:dir,codex_home:home,app_data:appdata,codex_command:process.execPath,launcher_sha256:hash(launcher)};
  writeFileSync(join(root,'installation-state.json'),JSON.stringify(state));
  const manifest:InstallManifest={owner:'codex-dots-bridge',instance_id:config.instance_id,codex_home:home,codex_command:process.execPath,mcp:{name:'codex-dots-bridge',command:process.execPath,args:[join(payload,'dist','main.js'),'stdio','--data-dir',dir]},skill:{path:join(home,'skills','codex-dots-bridge'),files:{'SKILL.md':hash(join(payload,'skills','codex-dots-bridge','SKILL.md'))}},autostart_launcher:launcher};
  mkdirSync(manifest.skill.path,{recursive:true});copyFileSync(join(payload,'skills','codex-dots-bridge','SKILL.md'),join(manifest.skill.path,'SKILL.md'));
  const manifestPath=join(dir,'installation.json');writeFileSync(manifestPath,JSON.stringify(manifest));
  const previous=process.env.APPDATA;process.env.APPDATA=appdata;
  return {base,root,payload,dir,appdata,home,launcher,state,manifest,manifestPath,path:startupPath(),close(){if(previous===undefined)delete process.env.APPDATA;else process.env.APPDATA=previous;rmSync(base,{recursive:true,force:true});}};
}
test.after(()=>{if(build)rmSync(build,{recursive:true,force:true});});

test('native inspect emits strict UTF8 without BOM for Chinese and non-CP936 path characters',{skip:!enabled},()=>{
  const f=fixture(true);try{
    const raw=execFileSync(f.launcher,['--startup','inspect'],{windowsHide:true,stdio:'pipe'});
    assert.equal(raw.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf])),false);
    const receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    assert.equal(receipt.path,f.path);assert.equal(receipt.exists,false);assert.equal(inspectStartupLink(f.launcher).path,f.path);
    assert.equal(existsSync(f.path),false);assert.equal(existsSync(join(f.root,'.startup-intent.json')),false);
  }finally{f.close();}
});

test('native toggle creates one stable visible-target link and repeated enable has zero link/binary writes',{skip:!enabled},()=>{
  const f=fixture();try{
    const config=readFileSync(join(f.dir,'config.json')),lock='original service owner',tasks='task/subscription preservation sentinel';writeFileSync(join(f.dir,'service.lock'),lock);writeFileSync(join(f.dir,'tasks.sqlite'),tasks);
    assert.equal(readTrayAutostart(f.dir),'disabled');setTrayAutostart(f.dir,true);
    const raw=execFileSync(f.launcher,['--startup','inspect'],{windowsHide:true,stdio:'pipe'});
    assert.equal(raw.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf])),false,'native receipt has no UTF8 BOM');
    assert.equal(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)).path,f.path,'receipt preserves Chinese path characters');
    const receipt=inspectStartupLink(f.launcher),bytes=readFileSync(f.path),mtime=statSync(f.path).mtimeMs,exeTime=statSync(f.launcher).mtimeMs;
    assert.equal(receipt.owned,true);assert.equal(receipt.exists,true);assert.equal(readTrayAutostart(f.dir),'enabled');assert.equal(existsSync(join(f.root,'.startup-intent.json')),false);
    setTrayAutostart(f.dir,true);assert.deepEqual(readFileSync(f.path),bytes);assert.equal(statSync(f.path).mtimeMs,mtime);assert.equal(statSync(f.launcher).mtimeMs,exeTime);
    assert.deepEqual(readFileSync(join(f.dir,'config.json')),config);assert.equal(readFileSync(join(f.dir,'service.lock'),'utf8'),lock);assert.equal(readFileSync(join(f.dir,'tasks.sqlite'),'utf8'),tasks);
    setTrayAutostart(f.dir,false);assert.equal(existsSync(f.path),false);assert.equal(readTrayAutostart(f.dir),'disabled');
  }finally{f.close();}
});
test('pending transaction and mismatched runtime fail before launch and leave a bounded native diagnostic',{skip:!enabled},()=>{
  const f=fixture();try{
    writeFileSync(join(f.root,'.setup-transaction.json'),'uncommitted transaction sentinel');
    assert.throws(()=>execFileSync(f.launcher,['--autostart'],{windowsHide:true,stdio:'pipe'}),error=>{assert.match(String((error as {stdout:Buffer}).stdout),/previous_installation_requires_recovery/);return true;});
    let record=JSON.parse(readFileSync(join(f.root,'.launcher-diagnostics.json'),'utf8'));assert.equal(record.owner,'codex-dots-bridge-launcher');assert.equal(record.outcome,'failed');assert.equal(record.code,'previous_installation_requires_recovery');assert.ok(JSON.stringify(record).length<1024);
    unlinkSync(join(f.root,'.setup-transaction.json'));
    assert.throws(()=>execFileSync(f.launcher,['--autostart'],{windowsHide:true,stdio:'pipe'}),error=>{assert.match(String((error as {stdout:Buffer}).stdout),/installation_binding_mismatch/);return true;});
    record=JSON.parse(readFileSync(join(f.root,'.launcher-diagnostics.json'),'utf8'));assert.equal(record.code,'installation_binding_mismatch');
  }finally{f.close();}
});
test('foreign link and user-modified native registration are preserved',{skip:!enabled},()=>{
  const f=fixture();try{
    mkdirSync(join(f.path,'..'),{recursive:true});writeFileSync(f.path,'foreign shortcut');const original=readFileSync(f.manifestPath,'utf8');
    assert.equal(readTrayAutostart(f.dir),'unknown');assert.throws(()=>setTrayAutostart(f.dir,true));assert.equal(readFileSync(f.path,'utf8'),'foreign shortcut');assert.equal(readFileSync(f.manifestPath,'utf8'),original);
  }finally{f.close();}
});
test('cross-payload owned MCP/Skill upgrade retains exact stable link; a failed skill copy restores old MCP and files',{skip:!enabled},()=>{
  const f=fixture();const exec=childProcess.execFileSync;let entry:unknown={name:'codex-dots-bridge',transport:{type:'stdio',command:f.manifest.mcp.command,args:f.manifest.mcp.args}};
  const cli=mock.method(childProcess,'execFileSync',((command:string,args:string[],options:unknown)=>{
    if(command===process.execPath&&args[0]==='mcp'){
      if(args[1]==='list')return JSON.stringify(entry?[entry]:[]);
      if(args[1]==='remove'){entry=undefined;return '';}
      if(args[1]==='add'){entry={name:args[2],transport:{type:'stdio',command:args[4],args:args.slice(5)}};return '';}
    }
    return (exec as Function)(command,args,options);
  }) as typeof childProcess.execFileSync);syncBuiltinESMExports();
  try{
    setTrayAutostart(f.dir,true);const bytes=readFileSync(f.path),mtime=statSync(f.path).mtimeMs;
    const next=join(f.root,'payload','0.2.0-alpha.25');mkdirSync(join(next,'dist'),{recursive:true});mkdirSync(join(next,'skills','codex-dots-bridge'),{recursive:true});writeFileSync(join(next,'dist','main.js'),'synthetic new payload');writeFileSync(join(next,'skills','codex-dots-bridge','SKILL.md'),'new skill');
    const options={nodePath:process.execPath,entryPath:join(next,'dist','main.js'),skillSource:join(next,'skills','codex-dots-bridge'),codexHome:f.home,codexCommand:process.execPath,upgrade:true,startupLauncher:f.launcher,preserveAutostart:true};
    const copy=fs.copyFileSync;const fault=mock.method(fs,'copyFileSync',((from:string,to:string)=>{if(from===join(options.skillSource,'SKILL.md'))throw new Error('synthetic skill copy rejected');return copy(from,to);}) as typeof fs.copyFileSync);syncBuiltinESMExports();
    assert.throws(()=>installCodex(f.dir,options),/synthetic skill copy rejected/);fault.mock.restore();syncBuiltinESMExports();
    assert.deepEqual((entry as {transport:{args:string[]}}).transport.args,f.manifest.mcp.args);assert.equal(readFileSync(join(f.manifest.skill.path,'SKILL.md'),'utf8'),'old skill');
    installCodex(f.dir,options);assert.equal((entry as {transport:{args:string[]}}).transport.args[0],options.entryPath);assert.equal(readFileSync(join(f.manifest.skill.path,'SKILL.md'),'utf8'),'new skill');assert.deepEqual(readFileSync(f.path),bytes);assert.equal(statSync(f.path).mtimeMs,mtime);
  }finally{cli.mock.restore();syncBuiltinESMExports();f.close();}
});
test('Windows disabled startup stays disabled without rewriting or changing its name',{skip:!enabled},()=>{
  const f=fixture();try{
    setTrayAutostart(f.dir,true);const before=readFileSync(f.path),manifest=readFileSync(f.manifestPath,'utf8');
    const original=childProcess.execFileSync;let writes=0;
    const adapter=mock.method(childProcess,'execFileSync',((command:string,args:string[],options:unknown)=>{
      if(command===f.launcher&&args[0]==='--startup'){
        if(args[1]!=='inspect')writes++;
        const response=JSON.parse(String((original as Function)(command,args,options)));response.windows='disabled';return JSON.stringify(response);
      }
      if(command===process.execPath&&args[0]==='mcp'&&args[1]==='list')return JSON.stringify([{name:'codex-dots-bridge',transport:{type:'stdio',command:f.manifest.mcp.command,args:f.manifest.mcp.args}}]);
      return (original as Function)(command,args,options);
    }) as typeof childProcess.execFileSync);syncBuiltinESMExports();
    try{
      assert.equal(readTrayAutostart(f.dir),'disabled');assert.throws(()=>setTrayAutostart(f.dir,true),/autostart_disabled_or_unconfirmed_by_windows/);assert.equal(writes,0);assert.deepEqual(readFileSync(f.path),before);assert.equal(readFileSync(f.manifestPath,'utf8'),manifest);
      installCodex(f.dir,{nodePath:process.execPath,entryPath:f.manifest.mcp.args[0]!,skillSource:join(f.payload,'skills','codex-dots-bridge'),codexHome:f.home,codexCommand:process.execPath,autostart:true});
      assert.equal(readTrayAutostart(f.dir),'disabled');assert.deepEqual(readFileSync(f.path),before);assert.equal(writes,0,'ordinary setup/Connect preserves the Windows choice without writing startup');
    }finally{adapter.mock.restore();syncBuiltinESMExports();}
  }finally{f.close();}
});
test('disabled autostart does not permit uninstall to execute or delete a replaced Launcher',{skip:!enabled},()=>{
  const f=fixture();try{
    setTrayAutostart(f.dir,true);setTrayAutostart(f.dir,false);
    const manifest=readFileSync(f.manifestPath,'utf8');writeFileSync(f.launcher,'user replacement executable sentinel');
    assert.throws(()=>uninstallCodex(f.dir),/modified_or_foreign_launcher/);
    assert.equal(readFileSync(f.launcher,'utf8'),'user replacement executable sentinel');assert.equal(readFileSync(f.manifestPath,'utf8'),manifest);
  }finally{f.close();}
});
