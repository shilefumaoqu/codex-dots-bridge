import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { initProduction, readProductionConfig } from '../src/runtime.js';
import { TaskStore } from '../src/task-store.js';

function cli(dir:string, args:string[], expected=0) {
  const result=spawnSync(process.execPath,['--import','tsx',resolve('src/main.ts'),...args,'--data-dir',dir],{encoding:'utf8',timeout:20000});
  assert.equal(result.error,undefined);
  assert.equal(result.status,expected,result.stdout+'\n'+result.stderr);
  return JSON.parse(result.stdout);
}

for(const withHistory of [false,true])test(`CLI migration handles ${withHistory?'completed legacy history':'fresh installation'} and gates activation`,{timeout:60000},()=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-cli-migration-')),dir=join(root,'data'),backup=join(root,'backup');
  const request={idempotency_key:'original-request',title:'Migration fixture',input:{text:'历史输入😀'}};
  let receipt:ReturnType<TaskStore['submit']>|undefined,completed:ReturnType<TaskStore['get']>|undefined;
  try {
    initProduction(dir);const instanceId=readProductionConfig(dir).instance_id;
    if(withHistory){
      const store=new TaskStore(join(dir,'tasks.sqlite'));
      try {
        receipt=JSON.parse(JSON.stringify(store.submit(request)));
        const claim=store.claim({task_id:receipt.task_id,claim_key:'original-claim'});
        store.checkpoint({task_id:receipt.task_id,claim_token:claim.claim_token,input_revision:1});
        store.complete({task_id:receipt.task_id,claim_token:claim.claim_token,input_revision:1,completion_key:'original-completion',result:{text:'保留的结果😀'}});
        completed=store.get(receipt.task_id);
      }finally{store.close();}
    }
    let migrated=cli(dir,['migrate-storage','--to',backup]);
    assert.equal(migrated.database_version,2);assert.equal(migrated.phase,'maintenance');
    assert.equal(readProductionConfig(backup).schema_version,1);
    assert.equal(readProductionConfig(dir).instance_id,instanceId);
    const refused=cli(dir,['run','--foreground'],1);
    assert.equal(refused.error,'storage_maintenance_required');
    if(withHistory){
      // The actual CLI rollback must restore old identities and configuration,
      // then allow a later migration with a new consistent backup.
      cli(dir,['rollback-storage','--migration-id',migrated.migration_id]);
      assert.equal(readProductionConfig(dir).schema_version,1);
      const restored=new TaskStore(join(dir,'tasks.sqlite'));
      try{assert.deepEqual(restored.get(receipt!.task_id),completed);assert.deepEqual(restored.submit(request),receipt);}finally{restored.close();}
      migrated=cli(dir,['migrate-storage','--to',join(root,'second-backup')]);
    }
    cli(dir,['activate-storage','--migration-id',migrated.migration_id]);
    const config=readProductionConfig(dir);assert.equal(config.schema_version,2);
    if(config.schema_version===2)assert.equal(config.storage.phase,'ready');
    assert.equal(cli(dir,['rollback-storage','--migration-id',migrated.migration_id],1).error,'rollback_after_activation_forbidden');
    const db=new Database(join(dir,'tasks.sqlite'),{readonly:true});
    try {
      for(const name of ['task_components','context_receipt_pages','desktop_read_snapshot_pages'])assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name),name);
    }finally{db.close();}
    if(withHistory){
      const migratedStore=new TaskStore(join(dir,'tasks.sqlite'));
      try{assert.deepEqual(migratedStore.get(receipt!.task_id),completed);assert.deepEqual(migratedStore.submit(request),receipt);}finally{migratedStore.close();}
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
