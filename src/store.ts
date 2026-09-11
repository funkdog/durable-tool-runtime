import { randomUUID } from 'node:crypto';
import { openDatabase, now, transaction } from './db.ts';
import type { Operation } from './types.ts';
import { installRunSchema } from './run-schema.ts';

export class Store {
  db: ReturnType<typeof openDatabase>;
  constructor(dir: string) {
    this.db = openDatabase(dir, 'governance');
    const grantColumns = this.db.prepare('PRAGMA table_info(grants)').all();
    if (grantColumns.length && !grantColumns.some(column => column.name === 'allowed_intent_refs_json')) {
      this.db.close(); throw new Error('INCOMPATIBLE_GRANT_SCHEMA: preserve this evidence directory and create a fresh POC run');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,epoch INTEGER NOT NULL,revision INTEGER NOT NULL,UNIQUE(tenant_id,id));
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,tenant_id TEXT,task_id TEXT,run_id TEXT,task_epoch INTEGER,
        expires_at INTEGER,revoked INTEGER NOT NULL DEFAULT 0,scopes_json TEXT NOT NULL,
        allowed_intent_refs_json TEXT NOT NULL CHECK(json_valid(allowed_intent_refs_json) AND json_type(allowed_intent_refs_json)='array'),
        FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id));
      CREATE TRIGGER IF NOT EXISTS grant_intents_immutable BEFORE UPDATE OF allowed_intent_refs_json ON grants
        WHEN NEW.allowed_intent_refs_json IS NOT OLD.allowed_intent_refs_json
        BEGIN SELECT RAISE(ABORT,'GRANT_INTENTS_IMMUTABLE'); END;
      CREATE TABLE IF NOT EXISTS intents (ref TEXT,tenant_id TEXT,task_id TEXT,business_key TEXT,input_json TEXT,definition_digest TEXT,
        PRIMARY KEY(tenant_id,ref),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES('tool_enabled','true');
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,task_id TEXT NOT NULL,intent_ref TEXT NOT NULL,
        intent_key TEXT NOT NULL,business_key TEXT NOT NULL,args_hash TEXT NOT NULL,input_json TEXT NOT NULL,definition_digest TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('reserve','cancel')),parent_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('ACCEPTED','DISPATCH_RECORDED','OUTCOME_UNKNOWN','APPLIED','NOT_APPLIED')),
        desired_action TEXT NOT NULL DEFAULT 'CONTINUE' CHECK(desired_action IN ('CONTINUE','CANCEL')),
        executor_epoch INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_until INTEGER,state_version INTEGER NOT NULL DEFAULT 1,
        next_attempt_at INTEGER,blocked_reason TEXT,result_json TEXT,created_at INTEGER NOT NULL,
        UNIQUE(tenant_id,intent_key),UNIQUE(tenant_id,id),
        FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,parent_id) REFERENCES operations(tenant_id,id));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,tenant_id TEXT,operation_id TEXT,seq INTEGER,type TEXT,payload TEXT,created_at INTEGER,
        UNIQUE(tenant_id,operation_id,seq),FOREIGN KEY(tenant_id,operation_id) REFERENCES operations(tenant_id,id));
      CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY REFERENCES events(id));
      CREATE TABLE IF NOT EXISTS deliveries (consumer_id TEXT,event_id TEXT REFERENCES events(id),created_at INTEGER,PRIMARY KEY(consumer_id,event_id));
      CREATE TABLE IF NOT EXISTS projections (consumer_id TEXT,operation_id TEXT,seq INTEGER,payload TEXT,PRIMARY KEY(consumer_id,operation_id));
      CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY,operation_id TEXT,executor_epoch INTEGER,payload TEXT,created_at INTEGER);
      CREATE TABLE IF NOT EXISTS checkpoints (tenant_id TEXT,task_id TEXT,run_id TEXT,operation_ids_json TEXT,created_at INTEGER,
        PRIMARY KEY(tenant_id,task_id,run_id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id));
    `);
    installRunSchema(this.db);
  }
  get(id: string): Operation | undefined { return this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as unknown as Operation | undefined; }
  event(id: string, type: string, detail: unknown = null): void {
    const op = this.get(id)!;
    const eventId = randomUUID();
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(eventId, op.tenant_id, id, op.state_version, type,
      JSON.stringify({ state: op.state, desiredAction: op.desired_action, executorEpoch: op.executor_epoch, detail }), now(this.db));
    this.db.prepare('INSERT INTO outbox VALUES(?)').run(eventId);
  }
  deliver(consumer: string, eventId: string): boolean {
    return transaction(this.db, () => {
      const event = this.db.prepare('SELECT operation_id,seq,payload FROM events WHERE id=?').get(eventId);
      if (!event) throw new Error('Event missing');
      const inserted = Number(this.db.prepare('INSERT OR IGNORE INTO deliveries VALUES(?,?,?)').run(consumer, eventId, now(this.db)).changes) === 1;
      if (inserted) this.db.prepare(`INSERT INTO projections VALUES(?,?,?,?) ON CONFLICT(consumer_id,operation_id)
        DO UPDATE SET seq=excluded.seq,payload=excluded.payload WHERE excluded.seq>projections.seq`)
        .run(consumer, event.operation_id, event.seq, event.payload);
      return inserted;
    });
  }
  snapshot() {
    return { tasks: this.db.prepare('SELECT * FROM tasks').all(), operations: this.db.prepare('SELECT * FROM operations ORDER BY created_at,id').all(),
      events: this.db.prepare('SELECT * FROM events ORDER BY created_at,operation_id,seq').all(), deliveries: this.db.prepare('SELECT * FROM deliveries').all(),
      observations: this.db.prepare('SELECT * FROM observations').all(), checkpoints: this.db.prepare('SELECT * FROM checkpoints').all(),
      projections: this.db.prepare('SELECT * FROM projections').all() };
  }
  close(): void { this.db.close(); }
}
