import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, initProduction, readProductionConfig, readToken, writeProductionConfig } from '../src/runtime.js';
import { backupData, restoreData } from '../src/maintenance.js';
import { activateStorage, assertStorageServingAllowed, inspectMaintenanceActivity, migrateStorage, preflightStorageMigration, rollbackStorageMigration, StorageMigrationError } from '../src/storage-migration.js';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'bridge-migration-')),dir=join(root,'data');
  initProduction(dir);
  const db=new Database(join(dir,'tasks.sqlite'));
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  db.prepare('INSERT INTO tasks VALUES(?,?)').run('existing-result',JSON.stringify({status:'completed',result:{id:'stable-result',text:'历史正文'}}));
  db.close();
  return {root,dir,backupDirectory:join(root,'backup'),close:()=>rmSync(root,{recursive:true,force:true})};
}

test('maintenance preflight accounts for all accepted work without advancing state',()=>{
  const f=fixture(),db=new Database(join(f.dir,'tasks.sqlite'));
  try {
    db.exec('CREATE TABLE desktop_conversation_requests(id TEXT,data TEXT);CREATE TABLE desktop_echo_requests(id TEXT,data TEXT);CREATE TABLE context_jobs(id TEXT,data TEXT)');
    const insert=(table:string,id:string,data:unknown)=>db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(id,JSON.stringify(data));
    insert('tasks','queued',{status:'queued'});
    insert('desktop_conversation_requests','send',{result:{operation:'send',status:'awaiting_delivery_choice'}});
    insert('desktop_conversation_requests','watch',{result:{operation:'send',status:'reconciliation_required'},watch:{state:'active'}});
    insert('desktop_conversation_requests','read',{result:{operation:'read',status:'pending'}});
    insert('desktop_echo_requests','echo',{result:{status:'pending'}});
    insert('context_jobs','context',{status:'pending'});
    const before=db.prepare('SELECT total_changes() AS n').get();
    assert.deepEqual(inspectMaintenanceActivity(db),{tasks:1,desktop_sends:2,desktop_reads:1,desktop_echo:1,context_reads:1,total:6});
    assert.throws(()=>preflightStorageMigration(f.dir),(error:unknown)=>error instanceof StorageMigrationError&&error.activity.total===6);
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(),before);
  }finally{db.close();f.close();}
});

test('migration owns runtime throughout backup, preserves identities and gates activation',async()=>{
  const f=fixture(),old=readProductionConfig(f.dir),caller=readToken(f.dir,'caller');
  try {
    let lockObserved=false;
    const original=Database.prototype.backup;
    Database.prototype.backup=function(...args:Parameters<typeof original>) {
      lockObserved=existsSync(join(f.dir,'service.lock'));
      assert.throws(()=>acquireLock(f.dir),/service_already_running/);
      return original.apply(this,args);
    };
    let result:Awaited<ReturnType<typeof migrateStorage>>;
    try {result=await migrateStorage(f.dir,{from:1,to:2,backupDirectory:f.backupDirectory,migrate:db=>db.exec('CREATE TABLE migrated(id TEXT PRIMARY KEY)')});}
    finally {Database.prototype.backup=original;}
    assert.equal(lockObserved,true);assert.equal(existsSync(join(f.dir,'service.lock')),false);
    const gated=readProductionConfig(f.dir);assert.equal(gated.schema_version,2);
    assert.equal(gated.instance_id,old.instance_id);assert.equal(readToken(f.dir,'caller'),caller);
    assert.equal(readProductionConfig(f.backupDirectory).schema_version,1);
    assert.throws(()=>assertStorageServingAllowed(f.dir),/storage_maintenance_required/);
    assert.throws(()=>activateStorage(f.dir,'wrong-id'),/migration_identity_mismatch/);
    activateStorage(f.dir,result.migration_id);assertStorageServingAllowed(f.dir);
    await assert.rejects(()=>rollbackStorageMigration(f.dir,result.migration_id),/rollback_after_activation_forbidden/);
    const db=new Database(join(f.dir,'tasks.sqlite'),{readonly:true});
    try {assert.equal(JSON.parse((db.prepare('SELECT data FROM tasks').get() as {data:string}).data).result.id,'stable-result');}finally{db.close();}
    writeProductionConfig(f.dir,old);
    assert.throws(()=>assertStorageServingAllowed(f.dir),/storage_version_mismatch/);
  }finally{f.close();}
});

test('migration transaction failure restores legacy config and leaves a readable snapshot',async()=>{
  const f=fixture(),before=readFileSync(join(f.dir,'config.json'),'utf8');
  try {
    await assert.rejects(()=>migrateStorage(f.dir,{from:1,to:2,backupDirectory:f.backupDirectory,migrate:db=>{db.exec('CREATE TABLE partial_change(id TEXT)');throw new Error('injected_failure');}}),/injected_failure/);
    assert.equal(readFileSync(join(f.dir,'config.json'),'utf8'),before);assertStorageServingAllowed(f.dir);
    assert.equal(existsSync(join(f.dir,'service.lock')),false);
    const db=new Database(join(f.dir,'tasks.sqlite'));
    try {assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='partial_change'").get(),undefined);}finally{db.close();}
    restoreData(f.backupDirectory,join(f.root,'restore'));
  }finally{f.close();}
});

test('preactivation rollback restores only the verified untouched snapshot',async()=>{
  const f=fixture(),before=readProductionConfig(f.dir);
  try {
    const result=await migrateStorage(f.dir,{from:1,to:2,backupDirectory:f.backupDirectory,migrate:db=>db.exec('CREATE TABLE migrated(id TEXT PRIMARY KEY)')});
    await rollbackStorageMigration(f.dir,result.migration_id);
    assert.deepEqual(readProductionConfig(f.dir),before);assertStorageServingAllowed(f.dir);
    const db=new Database(join(f.dir,'tasks.sqlite'));
    try {assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='migrated'").get(),undefined);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as {n:number}).n,1);}finally{db.close();}
  }finally{f.close();}
});

test('unexpected writes or changed backup prohibit preactivation rollback',async()=>{
  for(const failure of ['writes','backup'] as const) {
    const f=fixture();
    try {
      const result=await migrateStorage(f.dir,{from:1,to:2,backupDirectory:f.backupDirectory,migrate:()=>{}});
      const path=join(failure==='writes'?f.dir:f.backupDirectory,'tasks.sqlite'),db=new Database(path);
      db.prepare('INSERT INTO tasks VALUES(?,?)').run('new-result',JSON.stringify({status:'completed',result:'must never lose'}));db.close();
      await assert.rejects(()=>rollbackStorageMigration(f.dir,result.migration_id),new RegExp(failure==='writes'?'rollback_new_writes_detected':'backup_integrity_failed'));
      assert.equal(readProductionConfig(f.dir).schema_version,2);
    }finally{f.close();}
  }
});

test('interrupted snapshot rollback resumes from the durable source digest',async()=>{
  const f=fixture();
  try {
    const result=await migrateStorage(f.dir,{from:1,to:2,backupDirectory:f.backupDirectory,migrate:db=>db.exec('CREATE TABLE migrated(id TEXT)')});
    const original=Database.prototype.backup;
    Database.prototype.backup=async function(...args:Parameters<typeof original>) {await original.apply(this,args);throw new Error('interrupted_after_snapshot_commit');};
    try {await assert.rejects(()=>rollbackStorageMigration(f.dir,result.migration_id),/interrupted_after_snapshot_commit/);}
    finally {Database.prototype.backup=original;}
    assert.equal(readProductionConfig(f.dir).schema_version,2);
    assert.throws(()=>assertStorageServingAllowed(f.dir),/storage_maintenance_required/);
    await rollbackStorageMigration(f.dir,result.migration_id);
    assert.equal(readProductionConfig(f.dir).schema_version,1);assertStorageServingAllowed(f.dir);
    assert.equal(existsSync(join(f.dir,'storage-migration.json')),false);
  }finally{f.close();}
});

test('malformed optional configuration blocks preflight before migration or backup',async()=>{
  for(const name of ['desktop-conversations.json','desktop-echo.json','owner-notification.json']) {
    const f=fixture(),before=readFileSync(join(f.dir,'config.json'),'utf8');
    try {
      writeFileSync(join(f.dir,name),'{}');
      assert.throws(()=>preflightStorageMigration(f.dir),/invalid_backup_capability_config|owner_notification_config_invalid/);
      await assert.rejects(()=>migrateStorage(f.dir,{from:1,to:2,backupDirectory:f.backupDirectory,migrate:()=>assert.fail('must not migrate')}),/invalid_backup_capability_config|owner_notification_config_invalid/);
      assert.equal(readFileSync(join(f.dir,'config.json'),'utf8'),before);assert.equal(existsSync(f.backupDirectory),false);
    }finally{f.close();}
  }
});

test('optional desktop capability configurations survive verified backup and restore',async()=>{
  const f=fixture();
  try {
    const configs={
      'desktop-conversations.json':{enabled:false,mode:'local',codex_home:f.root,read:false,send:false},
      'desktop-echo.json':{enabled:true,thread_id:'11111111-1111-4111-8111-111111111111',request_id:'22222222-2222-4222-8222-222222222222',rollout_path:join(f.root,'rollout.jsonl'),expires_at:'2026-01-01T00:00:00.000Z'},
    };
    for(const [name,value] of Object.entries(configs))writeFileSync(join(f.dir,name),JSON.stringify(value));
    await backupData(f.dir,f.backupDirectory);restoreData(f.backupDirectory,join(f.root,'restored'));
    for(const name of Object.keys(configs))assert.equal(readFileSync(join(f.root,'restored',name),'utf8'),readFileSync(join(f.dir,name),'utf8'));
    assert.equal(JSON.parse(readFileSync(join(f.backupDirectory,'backup-manifest.json'),'utf8')).schema_version,2);
    writeFileSync(join(f.dir,'desktop-conversations.json'),'{}');
    await assert.rejects(()=>backupData(f.dir,join(f.root,'invalid')),/invalid_backup_capability_config/);
    assert.equal(existsSync(join(f.root,'invalid')),false);
  }finally{f.close();}
});

test('legacy config and backup manifest remain readable; stale runtime claims block migration',async()=>{
  const f=fixture();
  try {
    assertStorageServingAllowed(f.dir);await backupData(f.dir,f.backupDirectory);
    const path=join(f.backupDirectory,'backup-manifest.json'),manifest=JSON.parse(readFileSync(path,'utf8'));manifest.schema_version=1;writeFileSync(path,JSON.stringify(manifest));
    restoreData(f.backupDirectory,join(f.root,'legacy-restore'));
    writeFileSync(join(f.dir,'service.lock'),'unresolved-owner');
    assert.throws(()=>preflightStorageMigration(f.dir),/migration_requires_stopped_runtime/);
    assert.equal(readFileSync(join(f.dir,'service.lock'),'utf8'),'unresolved-owner');
  }finally{f.close();}
});
