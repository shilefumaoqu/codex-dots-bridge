import type Database from 'better-sqlite3';

const diagnosticKinds = new Set(['worker_ingress','worker_protocol_request','worker_protocol_response','desktop_ipc_failure','event_pump_error','maintenance_error','event_transport']);
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Old mixed evidence is retained; only explicitly classified new diagnostics are rotated. */
export class TaskDiagnostics {
  private readonly allocate: Database.Statement;
  private readonly business: Database.Statement;
  private readonly diagnostic: Database.Statement;
  private readonly pruneAge: Database.Statement;
  private readonly total: Database.Statement;
  private readonly pruneOldest: Database.Statement;
  constructor(private readonly db:Database.Database, private readonly now:()=>number) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),highwater INTEGER NOT NULL);
      INSERT OR IGNORE INTO task_cursor VALUES(1,0);
      UPDATE task_cursor SET highwater=max(highwater,(SELECT coalesce(max(id),0) FROM task_evidence));
      CREATE TABLE IF NOT EXISTS task_diagnostic_budget(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL);
      INSERT OR IGNORE INTO task_diagnostic_budget VALUES(1,0);
      CREATE TABLE IF NOT EXISTS task_diagnostics(id INTEGER PRIMARY KEY,at TEXT NOT NULL,kind TEXT NOT NULL,task_id TEXT,detail TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS diagnostics_age ON task_diagnostics(at);
      CREATE TABLE IF NOT EXISTS task_event_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),highwater INTEGER NOT NULL);
      INSERT OR IGNORE INTO task_event_sequence SELECT 1,max((SELECT highwater FROM task_cursor),(SELECT coalesce(max(id),0) FROM task_diagnostics));
      CREATE TRIGGER IF NOT EXISTS evidence_monotonic_cursor AFTER INSERT ON task_evidence BEGIN
        UPDATE task_evidence SET id=(SELECT max(highwater+1,NEW.id) FROM task_event_sequence) WHERE id=NEW.id;
        UPDATE task_event_sequence SET highwater=max(highwater,(SELECT max(id) FROM task_evidence));
        UPDATE task_cursor SET highwater=max(highwater,(SELECT max(id) FROM task_evidence));
      END;
      CREATE TRIGGER IF NOT EXISTS diagnostics_insert AFTER INSERT ON task_diagnostics BEGIN UPDATE task_diagnostic_budget SET bytes=bytes+NEW.bytes;END;
      CREATE TRIGGER IF NOT EXISTS diagnostics_delete AFTER DELETE ON task_diagnostics BEGIN UPDATE task_diagnostic_budget SET bytes=bytes-OLD.bytes;END;`);
    this.allocate=db.prepare('UPDATE task_event_sequence SET highwater=highwater+1 RETURNING highwater');
    this.business=db.prepare('INSERT INTO task_evidence(id,at,kind,task_id,detail) VALUES(?,?,?,?,?)');
    this.diagnostic=db.prepare('INSERT INTO task_diagnostics(id,at,kind,task_id,detail,bytes) VALUES(?,?,?,?,?,?)');
    this.pruneAge=db.prepare('DELETE FROM task_diagnostics WHERE at<?');
    this.total=db.prepare('SELECT bytes FROM task_diagnostic_budget WHERE singleton=1');
    this.pruneOldest=db.prepare('DELETE FROM task_diagnostics WHERE id IN (SELECT id FROM task_diagnostics ORDER BY id LIMIT 256)');
    this.rotate();
  }
  append(kind:string,taskId:string|null,detail:string) {
    this.db.transaction(()=>{
      const id=(this.allocate.get() as {highwater:number}).highwater;
      if(!Number.isSafeInteger(id))throw new Error('observer_sequence_exhausted');
      const at=new Date(this.now()).toISOString();
      if(diagnosticKinds.has(kind)) {this.diagnostic.run(id,at,kind,taskId,detail,Buffer.byteLength(at+kind+(taskId??'')+detail,'utf8')+8);this.rotate();}
      else this.business.run(id,at,kind,taskId,detail);
    })();
  }
  rotate() {
    this.pruneAge.run(new Date(this.now()-MAX_AGE_MS).toISOString());
    while((this.total.get() as {bytes:number}).bytes>MAX_BYTES)this.pruneOldest.run();
  }
}
