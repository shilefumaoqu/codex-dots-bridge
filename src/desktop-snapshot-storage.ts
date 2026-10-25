import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

const PAGE_CHARS = 32000;
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface Snapshot { total_chars: number; sha256: string }
export interface DesktopSnapshotPage {
  context_chunk: string;
  context_offset: number;
  next_offset: number | null;
  total_chars: number;
}

/** Schema 2 only. The lifecycle migration, never a compatibility constructor, converts old rows. */
export function initDesktopSnapshotStorage(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_read_snapshots (
    request_id TEXT PRIMARY KEY, total_chars INTEGER NOT NULL, sha256 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS desktop_read_snapshot_pages (
    request_id TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
    body BLOB NOT NULL, PRIMARY KEY(request_id,start_offset)
  )`);
}

/** Write each UTF-16 unit once. Page BLOBs preserve the public UTF-16 offset contract exactly. */
export function saveDesktopSnapshot(db: Database.Database, requestId: string, text: string): Snapshot {
  const snapshot = { total_chars: text.length, sha256: digest(text) };
  db.transaction(() => {
    const previous = db.prepare('SELECT total_chars,sha256 FROM desktop_read_snapshots WHERE request_id=?').get(requestId) as Snapshot | undefined;
    if (previous) {
      if (previous.total_chars !== snapshot.total_chars || previous.sha256 !== snapshot.sha256) fail('snapshot_binding_conflict');
      return;
    }
    db.prepare('INSERT INTO desktop_read_snapshots(request_id,total_chars,sha256) VALUES(?,?,?)').run(requestId,snapshot.total_chars,snapshot.sha256);
    const insert = db.prepare('INSERT INTO desktop_read_snapshot_pages(request_id,start_offset,end_offset,body) VALUES(?,?,?,?)');
    for (let start = 0; start < text.length; start += PAGE_CHARS) {
      const end = Math.min(text.length,start+PAGE_CHARS);
      insert.run(requestId,start,end,Buffer.from(text.slice(start,end),'utf16le'));
    }
  })();
  return snapshot;
}

/** Read at most the requested page and its two surrogate-boundary units, never the whole snapshot. */
export function readDesktopSnapshotPage(db: Database.Database, requestId: string, offset = 0, maxChars = PAGE_CHARS): DesktopSnapshotPage {
  const snapshot = db.prepare('SELECT total_chars,sha256 FROM desktop_read_snapshots WHERE request_id=?').get(requestId) as Snapshot | undefined;
  if (!snapshot || !Number.isSafeInteger(snapshot.total_chars) || snapshot.total_chars < 0) return fail('context_invalid');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.total_chars) return fail('invalid_offset');
  if (!Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars > PAGE_CHARS) return fail('invalid_page_size');
  const from = Math.max(0,offset-1), to = Math.min(snapshot.total_chars,offset+maxChars+1);
  const rows = db.prepare(`SELECT start_offset,end_offset,length(body) AS body_bytes,
    substr(body,(max(?,start_offset)-start_offset)*2+1,(min(?,end_offset)-max(?,start_offset))*2) AS body
    FROM desktop_read_snapshot_pages WHERE request_id=? AND start_offset>=? AND start_offset<? ORDER BY start_offset`)
    .all(from,to,from,requestId,Math.floor(from/PAGE_CHARS)*PAGE_CHARS,to) as {start_offset:number;end_offset:number;body_bytes:number;body:Buffer}[];
  let expected = Math.floor(from/PAGE_CHARS)*PAGE_CHARS;
  const chunks: Buffer[] = [];
  for (const row of rows) {
    if (row.start_offset !== expected || row.end_offset !== Math.min(snapshot.total_chars,row.start_offset+PAGE_CHARS) || row.body_bytes !== (row.end_offset-row.start_offset)*2 || row.body.length !== (Math.min(to,row.end_offset)-Math.max(from,row.start_offset))*2) return fail('context_invalid');
    chunks.push(row.body); expected = row.end_offset;
  }
  if (expected < to) return fail('context_invalid');
  const base = from, text = Buffer.concat(chunks).toString('utf16le');
  const splitsPair = (at: number) => at > 0 && at < snapshot.total_chars && /[\uD800-\uDBFF]/.test(text[at-base-1]!) && /[\uDC00-\uDFFF]/.test(text[at-base]!);
  if (splitsPair(offset)) return fail('invalid_offset');
  let end = Math.min(snapshot.total_chars,offset+maxChars);
  if (splitsPair(end)) end--;
  return { context_chunk:text.slice(offset-base,end-base),context_offset:offset,next_offset:end<snapshot.total_chars?end:null,total_chars:snapshot.total_chars };
}

/** Explicit maintenance migration. An outer lifecycle transaction also rolls back table creation. */
export function migrateDesktopSnapshotStorage(db: Database.Database): void {
  initDesktopSnapshotStorage(db);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_conversation_requests'").get()) return;
  db.transaction(() => {
    const ids = db.prepare('SELECT request_id FROM desktop_conversation_requests').all() as {request_id:string}[];
    const get = db.prepare('SELECT data FROM desktop_conversation_requests WHERE request_id=?');
    const update = db.prepare('UPDATE desktop_conversation_requests SET data=? WHERE request_id=?');
    for (const {request_id} of ids) {
      const row = get.get(request_id) as {data:string};
      const item = JSON.parse(row.data) as {snapshot_storage_version?:2;context_json?:string;result:{operation:string;status:string;context_sha256?:string}};
      if (item.result.operation !== 'read' || item.result.status !== 'completed') continue;
      if (item.snapshot_storage_version === 2) {
        if (!db.prepare('SELECT 1 FROM desktop_read_snapshots WHERE request_id=?').get(request_id)) fail('context_invalid');
        continue;
      }
      const context = item.context_json;
      if (typeof context !== 'string' || item.result.context_sha256 !== digest(context)) return fail('context_invalid');
      saveDesktopSnapshot(db,request_id,context);
      delete item.context_json; item.snapshot_storage_version = 2;
      update.run(JSON.stringify(item),request_id);
    }
  })();
}
