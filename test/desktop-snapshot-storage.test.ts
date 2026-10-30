import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash,randomUUID } from 'node:crypto';
import { initDesktopSnapshotStorage,migrateDesktopSnapshotStorage,readDesktopSnapshotPage,saveDesktopSnapshot } from '../src/desktop-snapshot-storage.js';

const digest = (text:string) => createHash('sha256').update(text).digest('hex');
test('fixed snapshots preserve arbitrary UTF-16 offsets and never cut surrogate pairs',()=>{
  const db=new Database(':memory:');try{
    initDesktopSnapshotStorage(db);
    const id=randomUUID(), text='x'.repeat(31999)+'🌟中'.repeat(40000);
    const meta=saveDesktopSnapshot(db,id,text);assert.equal(meta.sha256,digest(text));assert.equal(meta.total_chars,text.length);
    assert.equal(db.prepare('SELECT sum(length(body)) AS bytes FROM desktop_read_snapshot_pages').get()!.bytes,text.length*2);
    assert.deepEqual(saveDesktopSnapshot(db,id,text),meta);
    assert.throws(()=>saveDesktopSnapshot(db,id,text+'changed'),/snapshot_binding_conflict/);
    let combined='',offset=0;
    do {const page=readDesktopSnapshotPage(db,id,offset);assert(page.context_chunk.length<=32000);assert(page.context_chunk.isWellFormed());combined+=page.context_chunk;if(page.next_offset===null)break;offset=page.next_offset;}while(true);
    assert.equal(combined,text);assert.equal(digest(combined),meta.sha256);
    for(const start of [0,1,31998,31999,32001,63999,64002,text.length-1,text.length]) {
      const page=readDesktopSnapshotPage(db,id,start);assert.equal(page.context_chunk,text.slice(start,start+page.context_chunk.length));assert(page.context_chunk.isWellFormed());
    }
    for(const start of [-1,0.5,text.length+1,32000])assert.throws(()=>readDesktopSnapshotPage(db,id,start),/invalid_offset/);
    const empty=randomUUID();saveDesktopSnapshot(db,empty,'');assert.deepEqual(readDesktopSnapshotPage(db,empty),{context_chunk:'',context_offset:0,next_offset:null,total_chars:0});
    const plan=db.prepare('EXPLAIN QUERY PLAN SELECT body FROM desktop_read_snapshot_pages WHERE request_id=? AND start_offset>=? AND start_offset<? ORDER BY start_offset').all(id,0,32000) as {detail:string}[];
    assert(plan.some(row=>row.detail.includes('SEARCH')&&row.detail.includes('start_offset')));
  }finally{db.close();}
});

test('explicit migration preserves request metadata and digest, is repeatable and transactional',()=>{
  const db=new Database(':memory:');try{
    db.exec('CREATE TABLE desktop_conversation_requests(request_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    const id=randomUUID(),text=JSON.stringify({body:'历史🌟'.repeat(30000)}),legacy={context_json:text,binding:'same-binding',fingerprint:'same-request',sent:false,result:{request_id:id,operation:'read',status:'completed',context_sha256:digest(text),receipt_nonce:'same-receipt'}};
    const insert=db.prepare('INSERT INTO desktop_conversation_requests VALUES(?,?)');insert.run(id,JSON.stringify(legacy));
    assert.throws(()=>db.transaction(()=>{migrateDesktopSnapshotStorage(db);throw new Error('rollback');})(),/rollback/);
    assert.deepEqual(JSON.parse((db.prepare('SELECT data FROM desktop_conversation_requests').get() as {data:string}).data),legacy);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='desktop_read_snapshots'").get(),undefined);
    migrateDesktopSnapshotStorage(db);migrateDesktopSnapshotStorage(db);
    const stored=JSON.parse((db.prepare('SELECT data FROM desktop_conversation_requests').get() as {data:string}).data);
    assert.equal(stored.context_json,undefined);assert.equal(stored.snapshot_storage_version,2);assert.deepEqual(stored.result,legacy.result);assert.equal(stored.binding,legacy.binding);assert.equal(stored.fingerprint,legacy.fingerprint);
    assert.equal(readDesktopSnapshotPage(db,id,32001).context_chunk,text.slice(32001,64001));
    db.prepare('DELETE FROM desktop_read_snapshot_pages WHERE start_offset=32000').run();
    assert.throws(()=>readDesktopSnapshotPage(db,id,32001),/context_invalid/);
  }finally{db.close();}
});

test('migration refuses a changed source body without modifying any old requests',()=>{
  const db=new Database(':memory:');try{
    db.exec('CREATE TABLE desktop_conversation_requests(request_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    const original={context_json:'{}',result:{operation:'read',status:'completed',context_sha256:digest('{}')}};
    const changed={...original,context_json:'{"changed":true}'};
    db.prepare('INSERT INTO desktop_conversation_requests VALUES(?,?)').run('good',JSON.stringify(original));
    db.prepare('INSERT INTO desktop_conversation_requests VALUES(?,?)').run('bad',JSON.stringify(changed));
    assert.throws(()=>migrateDesktopSnapshotStorage(db),/context_invalid/);
    const rows=db.prepare('SELECT data FROM desktop_conversation_requests ORDER BY request_id').all() as {data:string}[];
    assert.deepEqual(rows.map(row=>JSON.parse(row.data)),[changed,original]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM desktop_read_snapshots').get()!.count,0);
  }finally{db.close();}
});
