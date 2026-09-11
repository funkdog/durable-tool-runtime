import { randomUUID } from 'node:crypto';
import { now, transaction } from './db.ts';
import type { Store } from './store.ts';
import type { Grant } from './types.ts';
import type { CallEvidence } from './agent-verdict.ts';

export class CallAudit {
  store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS call_audit(id TEXT PRIMARY KEY,grant_id TEXT,run_id TEXT,tool TEXT,args_json TEXT,
      started_at INTEGER,completed_at INTEGER,result_json TEXT);
      CREATE TABLE IF NOT EXISTS response_faults(tool TEXT PRIMARY KEY,mode TEXT,hits INTEGER NOT NULL DEFAULT 0,released INTEGER NOT NULL DEFAULT 0);`);
  }
  start(grant: Grant, tool: string, args: unknown): string {
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO call_audit VALUES(?,?,?,?,?,?,NULL,NULL)').run(id, grant.id, grant.run_id, tool, JSON.stringify(args), now(this.store.db)); return id;
  }
  finish(id: string, result: unknown): void {
    this.store.db.prepare('UPDATE call_audit SET result_json=?,completed_at=? WHERE id=? AND completed_at IS NULL').run(JSON.stringify(result), now(this.store.db), id);
  }
  list(runId?: string): CallEvidence[] {
    return (runId ? this.store.db.prepare('SELECT * FROM call_audit WHERE run_id=? ORDER BY started_at,id').all(runId)
      : this.store.db.prepare('SELECT * FROM call_audit ORDER BY started_at,id').all()) as unknown as CallEvidence[];
  }
  arm(tool: string, mode: 'drop' | 'hold'): void { this.store.db.prepare('INSERT INTO response_faults(tool,mode) VALUES(?,?)').run(tool, mode); }
  take(tool: string): 'drop' | 'hold' | undefined {
    return transaction(this.store.db, () => {
      const row = this.store.db.prepare('SELECT mode FROM response_faults WHERE tool=? AND hits=0').get(tool);
      if (!row) return undefined;
      this.store.db.prepare('UPDATE response_faults SET hits=1 WHERE tool=?').run(tool); return row.mode as 'drop' | 'hold';
    });
  }
  fault(tool: string) { return this.store.db.prepare('SELECT * FROM response_faults WHERE tool=?').get(tool); }
  release(tool: string) { this.store.db.prepare('UPDATE response_faults SET released=1 WHERE tool=?').run(tool); }
}
