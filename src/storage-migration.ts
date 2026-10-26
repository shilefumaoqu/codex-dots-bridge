import Database from 'better-sqlite3';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, renameSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireLock, readOwnerNotificationConfig, readProductionConfig, writeProductionConfig, type ProductionConfig } from './runtime.js';
import { ProbeError } from './store.js';
import { desktopConversationsConfigSchema } from './desktop-conversations.js';
import { desktopEchoConfigSchema } from './desktop-echo.js';

export interface MaintenanceActivity {
  tasks:number; desktop_sends:number; desktop_reads:number; desktop_echo:number; context_reads:number; total:number;
}
const fail=(code:string):never=>{throw new ProbeError(code);};
export const SUPPORTED_STORAGE_VERSION=2;
export class StorageMigrationError extends ProbeError {
  constructor(code:string,readonly activity:MaintenanceActivity){super(code);}
}
const tables=(db:Database.Database)=>new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
export function validateMaintenanceConfiguration(dir:string) {
  readProductionConfig(dir);readOwnerNotificationConfig(dir);
  for(const [name,schema] of [['desktop-conversations.json',desktopConversationsConfigSchema],['desktop-echo.json',desktopEchoConfigSchema]] as const) {
    const path=join(dir,name);if(!existsSync(path))continue;
    const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())fail('unsafe_file');
    try {schema.parse(JSON.parse(readFileSync(path,'utf8')));}catch {fail('invalid_backup_capability_config');}
  }
}

/** SQL-only inspection. Never constructs services or advances their state. */
export function inspectMaintenanceActivity(db:Database.Database):MaintenanceActivity {
  const present=tables(db);
  const taskStatus=present.has('tasks')&&(db.pragma('table_xinfo(tasks)') as {name:string}[]).some(column=>column.name==='status')?'status':"json_extract(data,'$.status')";
  const count=(table:string,where:string):number=>present.has(table)
    ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as {n:number}).n : 0;
  const activity={
    tasks:count('tasks',`${taskStatus} IN ('queued','running','waiting_input','cancel_requested','reconciliation_required')`),
    desktop_sends:count('desktop_conversation_requests',"json_extract(data,'$.result.operation')='send' AND (json_extract(data,'$.result.status') IN ('pending','waiting_next_turn','awaiting_delivery_choice') OR json_extract(data,'$.watch.state')='active')"),
    desktop_reads:count('desktop_conversation_requests',"json_extract(data,'$.result.operation')='read' AND json_extract(data,'$.result.status')='pending'"),
    desktop_echo:count('desktop_echo_requests',"json_extract(data,'$.result.status')='pending'"),
    context_reads:count('context_jobs',"json_extract(data,'$.status')='pending'"),
    total:0,
  };
  activity.total=activity.tasks+activity.desktop_sends+activity.desktop_reads+activity.desktop_echo+activity.context_reads;
  return activity;
}

interface StorageMetadata {
  version:number; migration_id:string; activated:number;
  backup_directory:string; backup_sha256:string; original_config:string; baseline_sha256:string;
}
interface MigrationJournal {
  owner:'codex-dots-bridge-storage-migration';instance_id:string;migration_id:string;
  original_config:ProductionConfig;source_digest:string;backup_directory:string;backup_sha256:string;
  phase:'prepared'|'migrated'|'rollback_started'|'activated';
}
function journalPath(dir:string){return join(dir,'storage-migration.json');}
function writeJournal(dir:string,value:MigrationJournal) {
  // Legacy runtimes already tolerate interrupted atomic config writes. Reusing
  // that temporary-name convention keeps an abandoned temp harmless on rollback.
  const temp=join(dir,`config.${randomUUID()}.tmp`);
  writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  try {renameSync(temp,journalPath(dir));}catch(error){try{unlinkSync(temp);}catch{}throw error;}
}
function readJournal(dir:string):MigrationJournal|undefined {
  const path=journalPath(dir);if(!existsSync(path))return;
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())fail('unsafe_migration_journal');
  const value=JSON.parse(readFileSync(path,'utf8')) as MigrationJournal;
  if(value.owner!=='codex-dots-bridge-storage-migration'||!value.migration_id||!value.original_config||value.instance_id!==value.original_config.instance_id||!/^[a-f0-9]{64}$/.test(value.source_digest)||!/^[a-f0-9]{64}$/.test(value.backup_sha256))fail('invalid_migration_journal');
  return value;
}
function removeJournal(dir:string,id:string) {if(readJournal(dir)?.migration_id===id)unlinkSync(journalPath(dir));}
function metadata(db:Database.Database):StorageMetadata|undefined {
  if(!tables(db).has('bridge_storage_metadata'))return;
  return db.prepare('SELECT * FROM bridge_storage_metadata WHERE id=1').get() as StorageMetadata|undefined;
}
function database(dir:string,readonly=true) {
  const path=join(dir,'tasks.sqlite');
  if(!existsSync(path))return fail('migration_database_missing');
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())fail('unsafe_database');
  return new Database(path,{readonly,fileMustExist:true});
}
function integrity(db:Database.Database) {
  if(db.pragma('quick_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)fail('migration_database_integrity_failed');
}
function assertNoActivity(db:Database.Database) {
  const activity=inspectMaintenanceActivity(db);
  if(activity.total)throw new StorageMigrationError('inflight_work_blocks_migration',activity);
  return activity;
}
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
/** Offline proof for rollback: even an unexpected diagnostic write blocks snapshot restore. */
function databaseDigest(db:Database.Database) {
  const hash=createHash('sha256');
  const entries=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name!='bridge_storage_metadata' AND name NOT LIKE 'sqlite_stat%' ORDER BY name").all() as {name:string;sql:string}[];
  for(const entry of entries) {
    hash.update(JSON.stringify(entry)+'\n');
    const order=/WITHOUT\s+ROWID/i.test(entry.sql)?(db.pragma(`table_info(${quote(entry.name)})`) as {name:string}[]).map(row=>quote(row.name)).join(','):'rowid';
    for(const row of db.prepare(`SELECT * FROM ${quote(entry.name)} ORDER BY ${order}`).safeIntegers().iterate()) {
      // SQLite rows contain only scalar values and Buffers. Encode each column
      // in the original property order, preserving the v1 digest bytes without
      // invoking the BigInt replacer for every byte in Buffer.toJSON().data.
      hash.update('{');let separator='';
      for(const [key,value] of Object.entries(row as Record<string,unknown>)) {
        hash.update(separator+JSON.stringify(key)+':');separator=',';
        hash.update(JSON.stringify(typeof value==='bigint'?{$integer:value.toString()}:value));
      }
      hash.update('}\n');
    }
  }
  return hash.digest('hex');
}
function fileDigest(path:string) {
  const hash=createHash('sha256'),fd=openSync(path,'r'),chunk=Buffer.allocUnsafe(1024*1024);
  try {let bytes:number;while((bytes=readSync(fd,chunk,0,chunk.length,null))>0)hash.update(chunk.subarray(0,bytes));return hash.digest('hex');}
  finally {closeSync(fd);}
}
function stopped(dir:string) {
  // A stale lock is still an unresolved ownership claim; do not delete it here.
  if(['service.lock','supervisor.lock'].some(name=>existsSync(join(dir,name))))fail('migration_requires_stopped_runtime');
}
export function preflightStorageMigration(dir:string) {
  const config=readProductionConfig(dir);stopped(dir);validateMaintenanceConfiguration(dir);
  if(config.schema_version===2&&config.storage.phase==='maintenance')fail('migration_requires_recovery');
  if(config.schema_version===2&&config.storage.database_version!==SUPPORTED_STORAGE_VERSION)fail('unsupported_storage_version');
  const db=database(dir);
  try {
    integrity(db);const activity=assertNoActivity(db);
    const current=metadata(db),version=current?.version??1;
    if(config.schema_version===2&&(config.storage.database_version!==version||current?.migration_id!==config.storage.migration_id||current.activated!==1))fail('storage_version_mismatch');
    if(config.schema_version===1&&version!==1)fail('storage_version_mismatch');
    const size=BigInt(lstatSync(join(dir,'tasks.sqlite')).size),fs=statfsSync(dir,{bigint:true});
    const required=size*3n+64n*1024n*1024n;
    if(fs.bavail*fs.bsize<required)fail('migration_insufficient_disk_space');
    return {instance_id:config.instance_id,database_version:version,activity,required_free_bytes:required.toString()};
  }finally{db.close();}
}

/** Guard all business entry points before exposing a maintenance database. */
export function assertStorageServingAllowed(dir:string):void {
  const config=readProductionConfig(dir);
  if(config.schema_version===2&&config.storage.phase!=='ready')fail('storage_maintenance_required');
  if(config.schema_version===2&&config.storage.database_version!==SUPPORTED_STORAGE_VERSION)fail('unsupported_storage_version');
  if(!existsSync(join(dir,'tasks.sqlite'))) {
    if(config.schema_version===2)fail('storage_version_mismatch');
    return;
  }
  const db=database(dir);
  try {
    const saved=metadata(db);
    if(config.schema_version===1) {if(saved&&saved.version!==1)fail('storage_version_mismatch');return;}
    if(saved?.version!==config.storage.database_version||saved.migration_id!==config.storage.migration_id||saved.activated!==1)fail('storage_version_mismatch');
  }finally{db.close();}
}

export interface StorageMigration {
  from:number; to:number; backupDirectory:string;
  /** A synchronous, database-only migration. This callback must not perform I/O. */
  migrate:(db:Database.Database)=>void;
}
/** Explicit migration only. Normal service construction must never call this. */
export async function migrateStorage(dir:string,plan:StorageMigration) {
  if(!Number.isSafeInteger(plan.from)||plan.from<1||!Number.isSafeInteger(plan.to)||plan.to!==plan.from+1||plan.to!==SUPPORTED_STORAGE_VERSION)fail('invalid_storage_migration');
  const preflight=preflightStorageMigration(dir);
  if(preflight.database_version!==plan.from)fail('migration_version_conflict');
  const original=readProductionConfig(dir);
  const migration_id=randomUUID();
  const gated:ProductionConfig={...original,schema_version:2,storage:{database_version:plan.to,migration_id,phase:'maintenance'}};
  const release=acquireLock(dir);
  let db:Database.Database|undefined,committed=false;
  try {
    if(existsSync(join(dir,'supervisor.lock')))fail('migration_requires_stopped_runtime');
    if(JSON.stringify(readProductionConfig(dir))!==JSON.stringify(original))fail('migration_source_changed');
    // Own the runtime lock throughout the asynchronous snapshot. No service can
    // start, finish new work and disappear between the backup and migration.
    db=database(dir,false);integrity(db);assertNoActivity(db);
    if((metadata(db)?.version??1)!==plan.from)fail('migration_version_conflict');
    const {backupData}=await import('./maintenance.js');
    const backup=await backupData(dir,plan.backupDirectory);
    if(JSON.stringify(readProductionConfig(dir))!==JSON.stringify(original))fail('migration_source_changed');
    const journal:MigrationJournal={owner:'codex-dots-bridge-storage-migration',instance_id:original.instance_id,migration_id,original_config:original,source_digest:databaseDigest(db),backup_directory:backup.backup_directory,backup_sha256:fileDigest(join(backup.backup_directory,'tasks.sqlite')),phase:'prepared'};
    writeJournal(dir,journal);
    writeProductionConfig(dir,gated); // Old strict schema-1 runtimes fail before opening the DB.
    db.transaction(()=>{
      assertNoActivity(db!);
      db!.exec('CREATE TABLE IF NOT EXISTS bridge_storage_metadata(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_id TEXT NOT NULL,activated INTEGER NOT NULL CHECK(activated IN (0,1)),backup_directory TEXT NOT NULL,backup_sha256 TEXT NOT NULL,original_config TEXT NOT NULL,baseline_sha256 TEXT NOT NULL)');
      plan.migrate(db!);
      integrity(db!);
      db!.prepare('INSERT INTO bridge_storage_metadata(id,version,migration_id,activated,backup_directory,backup_sha256,original_config,baseline_sha256) VALUES(1,?,?,0,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,migration_id=excluded.migration_id,activated=0,backup_directory=excluded.backup_directory,backup_sha256=excluded.backup_sha256,original_config=excluded.original_config,baseline_sha256=excluded.baseline_sha256').run(plan.to,migration_id,backup.backup_directory,fileDigest(join(backup.backup_directory,'tasks.sqlite')),JSON.stringify(original),databaseDigest(db!));
    }).immediate();
    committed=true;
    writeJournal(dir,{...journal,phase:'migrated'});
  }catch(error){
    // The transaction rolled back and this API never opened business ingress.
    // Restore only our exact maintenance gate; preserve any unexpected external edit.
    if(!committed&&JSON.stringify(readProductionConfig(dir))===JSON.stringify(gated))writeProductionConfig(dir,original);
    if(!committed&&JSON.stringify(readProductionConfig(dir))===JSON.stringify(original))removeJournal(dir,migration_id);
    throw error;
  }finally{try{db?.close();}finally{release();}}
  return {instance_id:original.instance_id,database_version:plan.to,migration_id,phase:'maintenance' as const,backup_directory:plan.backupDirectory};
}

/** Called only after installation commits; no migration, send or task execution here. */
export function activateStorage(dir:string,migrationId:string) {
  stopped(dir);const config=readProductionConfig(dir);
  if(config.schema_version!==2||config.storage.migration_id!==migrationId)throw new ProbeError('migration_identity_mismatch');
  if(config.storage.database_version!==SUPPORTED_STORAGE_VERSION)fail('unsupported_storage_version');
  const release=acquireLock(dir);let db:Database.Database|undefined;
  try {
    if(existsSync(join(dir,'supervisor.lock')))fail('migration_requires_stopped_runtime');
    if(JSON.stringify(readProductionConfig(dir))!==JSON.stringify(config))fail('migration_source_changed');
    db=database(dir,false);
    integrity(db);const saved=metadata(db);
    if(saved?.migration_id!==migrationId||saved.version!==config.storage.database_version)fail('storage_version_mismatch');
    assertNoActivity(db);
    db.prepare('UPDATE bridge_storage_metadata SET activated=1 WHERE id=1 AND migration_id=?').run(migrationId);
    writeProductionConfig(dir,{...config,storage:{...config.storage,phase:'ready'}});
    const journal=readJournal(dir);if(journal?.migration_id===migrationId)writeJournal(dir,{...journal,phase:'activated'});
  }finally{try{db?.close();}finally{release();}}
  return {database_version:config.storage.database_version,phase:'ready' as const};
}

/** Restore only the untouched, never-activated migration. Activated storage is forward-only. */
export async function rollbackStorageMigration(dir:string,migrationId:string) {
  stopped(dir);const config=readProductionConfig(dir);
  const journal=readJournal(dir);
  if(!journal||journal.migration_id!==migrationId||journal.instance_id!==config.instance_id)throw new ProbeError('migration_identity_mismatch');
  if(config.schema_version===2&&config.storage.migration_id!==migrationId)throw new ProbeError('migration_identity_mismatch');
  if(config.schema_version===2&&config.storage.phase!=='maintenance'||journal.phase==='activated')fail('rollback_after_activation_forbidden');
  const release=acquireLock(dir);let db:Database.Database|undefined,source:Database.Database|undefined;
  try {
    if(existsSync(join(dir,'supervisor.lock')))fail('migration_requires_stopped_runtime');
    if(JSON.stringify(readProductionConfig(dir))!==JSON.stringify(config))fail('migration_source_changed');
    db=database(dir,false);integrity(db);const saved=metadata(db);
    // A previous restore may have committed before the config rename. Prove the
    // exact pre-migration database, then finish only that interrupted rollback.
    if(!saved&&['prepared','rollback_started'].includes(journal.phase)&&databaseDigest(db)===journal.source_digest) {
      writeProductionConfig(dir,journal.original_config);removeJournal(dir,migrationId);
      return {instance_id:config.instance_id,database_version:1,phase:'ready' as const};
    }
    if(!saved||config.schema_version!==2||saved.migration_id!==migrationId||saved.version!==config.storage.database_version)throw new ProbeError('storage_version_mismatch');
    if(saved.activated!==0)fail('rollback_after_activation_forbidden');
    assertNoActivity(db);
    if(databaseDigest(db)!==saved.baseline_sha256)fail('rollback_new_writes_detected');
    const backupPath=join(resolve(saved.backup_directory),'tasks.sqlite');
    const info=lstatSync(backupPath);if(!info.isFile()||info.isSymbolicLink()||fileDigest(backupPath)!==saved.backup_sha256)fail('backup_integrity_failed');
    const original=JSON.parse(saved.original_config) as ProductionConfig;
    if(original.instance_id!==config.instance_id)fail('backup_instance_mismatch');
    source=new Database(backupPath,{readonly:true,fileMustExist:true});integrity(source);
    if(databaseDigest(source)!==journal.source_digest)fail('backup_integrity_failed');
    writeJournal(dir,{...journal,phase:'rollback_started'});
    db.close();db=undefined;
    // SQLite's backup API commits replacement atomically; never delete the live
    // database and never restore a directory over credentials or newer results.
    await source.backup(join(dir,'tasks.sqlite'));
    writeProductionConfig(dir,original);
    removeJournal(dir,migrationId);
    return {instance_id:config.instance_id,database_version:original.schema_version===2?original.storage.database_version:1,phase:'ready' as const};
  }finally{try{db?.close();source?.close();}finally{release();}}
}
