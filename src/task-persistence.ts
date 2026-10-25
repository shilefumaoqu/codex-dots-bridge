import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { StoredTask } from './task-store.js';

const FORMAT = '__task_storage_version';
const statementCaches=new WeakMap<Database.Database, Map<string,Database.Statement>>();
const statement=(db:Database.Database,sql:string)=>{let cache=statementCaches.get(db);if(!cache){cache=new Map();statementCaches.set(db,cache);}let value=cache.get(sql);if(!value){value=db.prepare(sql);cache.set(sql,value);}return value;};
const immutableParts=new WeakMap<object,string>();
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fingerprint = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const createComponents = (db: Database.Database) => db.exec(`CREATE TABLE IF NOT EXISTS task_components(
  task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, parent INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,kind,parent,position));
  CREATE TABLE IF NOT EXISTS task_storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);

export function normalizedTaskStorage(db: Database.Database): boolean {
  return !!statement(db,"SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_storage_meta'").get()
    && (statement(db,"SELECT value FROM task_storage_meta WHERE key='version'").get() as {value:string}|undefined)?.value === '2';
}

/** Metadata stays queryable without loading any historical body. */
export function readStoredTask(db: Database.Database, data: string, includeParent=true): StoredTask {
  const header = JSON.parse(data);
  if (header[FORMAT] !== 2) return header;
  delete header[FORMAT];
  delete header.__lease_until;
  const parts = statement(db,'SELECT kind,parent,position,data FROM task_components WHERE task_id=? ORDER BY parent,position').all(header.task_id) as {kind:string;parent:number;position:number;data:string}[];
  const task = {...header,attempts:[],messages:[],questions:[],results:[]} as StoredTask;
  const checkpoints = new Map<number, {position:number;value:any}[]>();
  for (const part of parts) {
    if(!includeParent && ['parent_context','parent_context_ref'].includes(part.kind))continue;
    const value = JSON.parse(part.data);
    if(value && typeof value==='object' && ['input','messages','checkpoints'].includes(part.kind))immutableParts.set(value,header.task_id);
    if (part.kind === 'input') task.input = value;
    else if (part.kind === 'parent_context') task.parent_context = value;
    else if(part.kind==='parent_context_ref') {
      const row=statement(db,'SELECT data FROM tasks WHERE id=?').get(value.task_id) as {data:string}|undefined;
      if(!row)throw new Error('task_parent_reference_missing');
      const parent=readStoredTask(db,row.data,false);
      task.parent_context={...value,input:parent.input,messages:parent.messages.filter(message=>message.input_revision<=value.input_revision),result:parent.results.find(result=>result.result_id===value.result_id)?.result};
    }
    else if (part.kind === 'attempts') task.attempts[part.position] = {...value, checkpoints:[]};
    else if (part.kind === 'checkpoints') { const list=checkpoints.get(part.parent)??[]; list.push({position:part.position,value}); checkpoints.set(part.parent,list); }
    else if (part.kind === 'messages') task.messages[part.position] = value;
    else if (part.kind === 'questions') task.questions[part.position] = value;
    else if (part.kind === 'results') task.results[part.position] = value;
  }
  for (const [parent, list] of checkpoints) {
    if (!task.attempts[parent]) throw new Error('task_storage_invalid');
    task.attempts[parent]!.checkpoints = list.sort((a,b)=>a.position-b.position).map(item=>item.value);
  }
  if (!task.input) throw new Error('task_storage_invalid');
  return task;
}

export function writeStoredTask(db: Database.Database, task: StoredTask, normalized: boolean): void {
  if (!normalized) {
    statement(db,'INSERT INTO tasks(id,request_key,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.task_id,task.idempotency_key,stable(task));
    return;
  }
  const {input,messages,questions,results,attempts,parent_context,...header} = task;
  statement(db,'INSERT INTO tasks(id,request_key,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.task_id,task.idempotency_key,stable({...header,[FORMAT]:2,__lease_until:attempts.at(-1)?.lease_until}));
  const put = statement(db,'INSERT INTO task_components(task_id,kind,parent,position,data) VALUES(?,?,?,?,?) ON CONFLICT(task_id,kind,parent,position) DO UPDATE SET data=excluded.data WHERE task_components.data<>excluded.data');
  const save=(kind:string,value:unknown,position=0,parent=0)=>{if(value && typeof value==='object' && immutableParts.get(value as object)===task.task_id)return;put.run(task.task_id,kind,parent,position,stable(value));};
  save('input',input);
  if(parent_context!==undefined && !statement(db,"SELECT 1 FROM task_components WHERE task_id=? AND kind IN ('parent_context','parent_context_ref') LIMIT 1").get(task.task_id)) {
    const context=parent_context as Record<string,unknown>,row=typeof context.task_id==='string'?statement(db,'SELECT data FROM tasks WHERE id=?').get(context.task_id) as {data:string}|undefined:undefined;
    let reference=false;
    if(row){const parent=readStoredTask(db,row.data,false);const reconstructed={task_id:parent.task_id,title:parent.title,input:parent.input,messages:parent.messages.filter(message=>message.input_revision<=(context.input_revision as number)),result_id:context.result_id,result:parent.results.find(result=>result.result_id===context.result_id)?.result,status:context.status,input_revision:context.input_revision};reference=fingerprint(reconstructed)===fingerprint(context);}
    if(reference){const {input:_input,messages:_messages,result:_result,...ref}=context;save('parent_context_ref',ref);}else save('parent_context',parent_context);
  }
  for(const [kind,parts] of Object.entries({messages,questions,results})) parts.forEach((part,position)=>save(kind,part,position));
  attempts.forEach(({checkpoints,...attempt},position)=>{save('attempts',attempt,position);checkpoints.forEach((checkpoint,index)=>save('checkpoints',checkpoint,index,position));});
}

/** Only called by the stopped-instance migration gate, never implicitly on open. */
export function migrateTaskStorage(db: Database.Database): {tasks:number;version:2} {
  return db.transaction(() => {
    createComponents(db);
    if(normalizedTaskStorage(db)) return {tasks:(statement(db,'SELECT count(*) AS count FROM tasks').get() as {count:number}).count,version:2 as const};
    let tasks=0,last='';
    for(;;) {
      const rows=statement(db,'SELECT id,data FROM tasks WHERE id>? ORDER BY id LIMIT 100').all(last) as {id:string;data:string}[];
      if(!rows.length)break;
      for (const row of rows) {
      const task:StoredTask=JSON.parse(row.data), expected=fingerprint(task);
      writeStoredTask(db,task,true);
      const saved=(statement(db,'SELECT data FROM tasks WHERE id=?').get(row.id) as {data:string}).data;
      if(fingerprint(readStoredTask(db,saved))!==expected) throw new Error('task_migration_verification_failed');
      tasks++;last=row.id;
      }
    }
    statement(db,"INSERT INTO task_storage_meta(key,value) VALUES('version','2')").run();
    return {tasks,version:2 as const};
  })();
}
