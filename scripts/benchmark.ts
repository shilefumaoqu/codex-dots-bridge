/** Synthetic local storage benchmark. Never opens an existing database or sends a message.
 * Run: node --import tsx scripts/benchmark.ts
 * Fast smoke: node --import tsx scripts/benchmark.ts --sizes 1000 --samples 20 --messages 100
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { TaskStore, type StoredTask } from '../src/task-store.js';
import { migrateTaskStorage, writeStoredTask } from '../src/task-persistence.js';
import { ContextService } from '../src/context-service.js';

const { values } = parseArgs({options: {
  sizes: {type: 'string', default: '1000,10000,100000'},
  samples: {type: 'string', default: '100'},
  messages: {type: 'string', default: '100,1000'},
  waiters: {type: 'string', default: '1,10,50'},
  storage: {type: 'string', default: '1,2'},
}});
function numbers(raw: string, maximum: number): number[] {
  const result = raw.split(',').map(Number);
  if (!result.length || result.some(n => !Number.isSafeInteger(n) || n < 1 || n > maximum))
    throw new Error(`Expected positive integers no larger than ${maximum}`);
  return [...new Set(result)].sort((a,b) => a-b);
}
const sizes = numbers(values.sizes!, 100000), messages = numbers(values.messages!, 1000);
const waiterCounts = numbers(values.waiters!, 50), samples = numbers(values.samples!, 1000)[0]!;
const storageVersions = numbers(values.storage!, 2);
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const round = (value: number) => Math.round(value * 1000) / 1000;
function sample(action: () => unknown) {
  for (let i=0;i<20;i++) action();
  const timings: number[] = [];
  for (let i=0;i<samples;i++) { const start=performance.now(); action(); timings.push(performance.now()-start); }
  timings.sort((a,b) => a-b);
  return {samples, p50_ms:round(timings[Math.ceil(samples*.50)-1]!), p95_ms:round(timings[Math.ceil(samples*.95)-1]!), p99_ms:round(timings[Math.ceil(samples*.99)-1]!)};
}
function databaseBytes(store: TaskStore, path: string) {
  const bytes = (name: string) => { try { return statSync(name).size; } catch { return 0; } };
  return {sqlite_logical_bytes: Number(store.db.pragma('page_count', {simple:true})) * Number(store.db.pragma('page_size', {simple:true})),
    database_file_bytes:bytes(path), wal_file_bytes:bytes(path+'-wal')};
}
async function scratch(storageVersion:number, action: (store:TaskStore,path:string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(),'codex-dots-benchmark-')), path=join(directory,'synthetic.sqlite');
  let store = new TaskStore(path);
  if(storageVersion===2){migrateTaskStorage(store.db);store.close();store=new TaskStore(path);}
  try { await action(store,path); } finally {store.close();rmSync(directory,{recursive:true,force:true});}
}
let commit: string | null = null;
let worktreeDirty: boolean | null = null;
try { commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
try { worktreeDirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
const sourceHash=createHash('sha256');
for(const file of readdirSync(new URL('../src/',import.meta.url),{recursive:true}).map(String).filter(file=>file.endsWith('.ts')).sort())
  sourceHash.update(file).update('\0').update(readFileSync(new URL('../src/'+file,import.meta.url))).update('\0');
sourceHash.update(readFileSync(new URL(import.meta.url)));
const packageInfo=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
emit({kind:'environment',version:packageInfo.version,commit,worktree_dirty:worktreeDirty,source_sha256:sourceHash.digest('hex'),platform:process.platform,arch:process.arch,
  os_release:release(),node:process.version,cpu:cpus()[0]?.model,cpu_count:cpus().length,total_memory_bytes:totalmem(),
  started_at:new Date().toISOString(),scope:'synthetic SQLite on local temporary disk; no Windows or remote acceptance implied',
  settings:{sizes,samples,messages,waiterCounts,storageVersions,history_input_chars:1024,history_result_chars:4096}});

for (const storageVersion of storageVersions) for (const count of sizes) await scratch(storageVersion,(store,path) => {
  const current = store.submit({idempotency_key:'benchmark-current',title:'Synthetic active task',input:{text:'active'}});
  const insert = store.db.prepare('INSERT INTO tasks(id,request_key,data) VALUES(?,?,?)');
  const saved: StoredTask = {...current,input:{text:'i'.repeat(1024)},status:'completed',result_id:'synthetic-result',
    results:[{result_id:'synthetic-result',input_revision:1,accepted_as_final:true,disposition:'final',at:current.created_at,result:{text:'r'.repeat(4096)}}]};
  const seededAt=performance.now();
  store.db.transaction(() => {
    for(let i=1;i<count;i++) {
      const id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
      const task={...saved,task_id:id,idempotency_key:'history-'+i,queued_order:i+1};
      if(storageVersion===2)writeStoredTask(store.db,task,true);
      else insert.run(id,'history-'+i,JSON.stringify(task));
    }
  })();
  store.db.pragma('wal_checkpoint(TRUNCATE)');
  const columns = new Set((store.db.pragma('table_xinfo(tasks)') as {name:string}[]).map(row=>row.name));
  const plans = {
    get:store.db.prepare('EXPLAIN QUERY PLAN SELECT data FROM tasks WHERE id=?').all(current.task_id),
    counts:store.db.prepare('EXPLAIN QUERY PLAN SELECT '+(columns.has('status')?'status':"json_extract(data,'$.status')")+' AS state,COUNT(*) FROM tasks GROUP BY state').all(),
    expiry: columns.has('next_due') ? store.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE next_due IS NOT NULL AND next_due<=? ORDER BY next_due').all(new Date().toISOString()) : 'indexed expiry unavailable',
  };
  const summary = () => (store.status as (options?:{summary:boolean})=>unknown).call(store,{summary:true});
  emit({kind:'history_queries',storage_version:storageVersion,total_tasks:count,seed_ms:round(performance.now()-seededAt),get:sample(()=>store.get(current.task_id)),
    status_summary:sample(summary),list_recent_10:sample(()=>store.listSummaries({limit:10})),query_plans:plans,
    memory:process.memoryUsage(),...databaseBytes(store,path)});
});

for (const storageVersion of storageVersions) for (const mode of ['full','compact'] as const) for(const count of messages) await scratch(storageVersion,(store,path)=>{
  const task=store.submit({idempotency_key:'benchmark-growth',title:'Synthetic message growth',input:{text:'i'.repeat(1024)},response_mode:mode});
  const start=performance.now();
  for(let i=0;i<count;i++) store.message({task_id:task.task_id,message_key:'message-'+i,text:'m'.repeat(1024),response_mode:mode});
  const logical = store.db.prepare('SELECT SUM(length(CAST(body AS BLOB))) body_bytes,SUM(length(CAST(response AS BLOB))) response_bytes FROM task_operations').get();
  emit({kind:'message_growth',storage_version:storageVersion,mode,message_count:count,elapsed_ms:round(performance.now()-start),operation_json_bytes:logical,
    task_json_bytes:store.db.prepare('SELECT length(CAST(data AS BLOB)) bytes FROM tasks WHERE id=?').get(task.task_id),
    component_json_bytes:storageVersion===2?store.db.prepare('SELECT SUM(length(CAST(data AS BLOB))) bytes FROM task_components WHERE task_id=?').get(task.task_id):null,
    memory:process.memoryUsage(),...databaseBytes(store,path)});
});

// Keep input size and preparation identical for both checkpoint response modes.
for(const storageVersion of storageVersions) for(const mode of ['full','compact'] as const) for(const count of messages) await scratch(storageVersion,(store,path)=>{
  const task=store.submit({idempotency_key:'checkpoint',title:'Synthetic long task',input:{text:'i'.repeat(1024)},response_mode:'compact'});
  const claim=store.claim({task_id:task.task_id,claim_key:'checkpoint',response_mode:'compact'});
  for(let i=0;i<count;i++)store.message({task_id:task.task_id,message_key:'m'+i,text:'m'.repeat(1024),response_mode:'compact'});
  emit({kind:'checkpoint_growth',storage_version:storageVersion,mode,message_count:count,seed_response_mode:'compact',
    checkpoint:sample(()=>store.checkpoint({task_id:task.task_id,claim_token:claim.claim_token,input_revision:count+1,response_mode:mode,summary:'Synthetic checkpoint'})),
    scope:'TaskStore checkpoint including transaction, lease, append and response construction; no network',...databaseBytes(store,path)});
});

for(const count of sizes) await scratch(2,async(store,path)=>{
  const contexts=new ContextService(store.db);
  try {
    const insert=store.db.prepare('INSERT INTO context_jobs(id,scope,thread,data) VALUES(?,?,?,?)');
    store.db.transaction(()=>{
      for(let i=0;i<count;i++)insert.run('synthetic-job-'+i,'synthetic-scope','synthetic-thread',JSON.stringify({continuation_token:'token-'+i,base:{state:'s'.repeat(1024)}}));
    })();
    const sql='SELECT data FROM context_jobs WHERE scope=? AND thread=? AND continuation_token=? LIMIT 1',args=['synthetic-scope','synthetic-thread','token-'+(count-1)];
    const query=store.db.prepare(sql);
    emit({kind:'context_continuation_lookup',total_jobs:count,job_state_chars:1024,lookup:sample(()=>JSON.parse((query.get(...args) as {data:string}).data)),
      query_plan:store.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args),scope:'Exact SQL lookup and JSON parsing only; excludes source reading and context preparation',...databaseBytes(store,path)});
  }finally{await contexts.close();}
});

for (const storageVersion of storageVersions) for (const count of waiterCounts) await scratch(storageVersion,async store=>{
  const wait=(store as any).waitForChange as undefined | ((id:string,after:number,ms:number,signal?:AbortSignal)=>Promise<void>);
  if(!wait){emit({kind:'waiters',storage_version:storageVersion,count,status:'unsupported'});return;}
  const task=store.submit({idempotency_key:'benchmark-wait',title:'Synthetic wait',input:{text:'wait'}});
  let selectExecutions=0;
  // SQLite trace counts executed statements rather than only prepared statements.
  const prepare=store.db.prepare.bind(store.db);
  (store.db as any).prepare=(sql:string)=>{
    const statement=prepare(sql);
    if(/^SELECT\b/i.test(sql.trim())) for(const method of ['get','all','iterate'] as const) {
      const original=statement[method].bind(statement);
      (statement as any)[method]=(...args:unknown[])=>{selectExecutions++;return original(...args);};
    }
    return statement;
  };
  const start=performance.now();
  const pending=Array.from({length:count},()=>wait.call(store,task.task_id,task.change_sequence,2000));
  const registrationSelects=selectExecutions;
  await new Promise(resolve=>setTimeout(resolve,250));
  const idleSelects=selectExecutions-registrationSelects;
  store.message({task_id:task.task_id,message_key:'wake',text:'wake',response_mode:'compact'});
  await Promise.all(pending);
  emit({kind:'waiters',storage_version:storageVersion,count,registration_select_executions:registrationSelects,idle_250ms_select_executions:idleSelects,
    elapsed_ms:round(performance.now()-start),retained_waiter_groups:(store as any).waiters?.size,memory:process.memoryUsage()});
});
