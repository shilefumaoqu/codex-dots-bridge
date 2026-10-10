import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { configureDesktopAccess } from '../src/desktop-conversation-settings.js';
import { initProduction } from '../src/runtime.js';

test('one setup enables the selected local capabilities and preserves legacy receipt bindings', () => {
  const root=mkdtempSync(join(tmpdir(),'desktop-access-')), data=join(root,'data'), home=join(root,'Codex Home');
  try {
    mkdirSync(home); initProduction(data);
    const target={thread_id:randomUUID(),rollout_path:join(home,'sessions','legacy.jsonl'),title:'synthetic'};
    const path=join(data,'desktop-conversations.json');
    writeFileSync(path,JSON.stringify({enabled:true,targets:[target]}));
    const first=configureDesktopAccess(data,'read',home);
    assert.equal(first.read,true); assert.equal(first.send,false); assert.equal(first.per_thread_configuration,false);
    let saved=JSON.parse(readFileSync(path,'utf8'));
    assert.equal(saved.mode,'local'); assert.deepEqual(saved.legacy_targets,[target]); assert.equal(saved.targets,undefined);
    configureDesktopAccess(data,'read-send');
    saved=JSON.parse(readFileSync(path,'utf8')); assert.equal(saved.send,true); assert.deepEqual(saved.legacy_targets,[target]);
    rmdirSync(home);
    const disabled=configureDesktopAccess(data,'off');
    assert.equal(disabled.mode,'disabled'); assert.equal(disabled.read,false); assert.equal(disabled.send,false);
    saved=JSON.parse(readFileSync(path,'utf8')); assert.equal(saved.enabled,false); assert.deepEqual(saved.legacy_targets,[target]);
    mkdirSync(home); configureDesktopAccess(data,'read-send');
    const before=readFileSync(path,'utf8');
    assert.throws(()=>configureDesktopAccess(data,'all',home),/invalid_desktop_access/);
    assert.throws(()=>configureDesktopAccess(data,'read','relative-home'),/invalid_codex_home/);
    assert.equal(readFileSync(path,'utf8'),before);
    writeFileSync(join(data,'service.lock'),JSON.stringify({pid:process.pid,owner:randomUUID()}));
    assert.throws(()=>configureDesktopAccess(data,'read-send',home),/stop_service_first/);
    assert.equal(readFileSync(path,'utf8'),before);
  } finally { const owned=relative(resolve(tmpdir()),resolve(root)); assert(!isAbsolute(owned)&&owned.startsWith('desktop-access-')&&!owned.includes('..')); rmSync(root,{recursive:true,force:true}); }
});

test('setup refuses unknown configuration instead of overwriting it', () => {
  const root=mkdtempSync(join(tmpdir(),'desktop-access-')), data=join(root,'data'), home=join(root,'home');
  try {
    mkdirSync(home); initProduction(data); const path=join(data,'desktop-conversations.json');
    const existing=JSON.stringify({enabled:true,unrelated_owner:true}); writeFileSync(path,existing);
    assert.throws(()=>configureDesktopAccess(data,'read-send',home),/invalid_desktop_configuration/); assert.equal(readFileSync(path,'utf8'),existing);
  }
  finally { const owned=relative(resolve(tmpdir()),resolve(root)); assert(!isAbsolute(owned)&&owned.startsWith('desktop-access-')&&!owned.includes('..')); rmSync(root,{recursive:true,force:true}); }
});
