import { randomBytes, randomUUID } from 'node:crypto';
import { Catalog } from './catalog.ts';
import { digest, now, transaction } from './db.ts';
import { Store } from './store.ts';
import { DomainError, type Task, type ReservationInput } from './types.ts';

// Trusted fixture/control API. Never registered as MCP tools.
export class Controller {
  store: Store;
  catalog: Catalog;
  constructor(store: Store, catalog = new Catalog()) { this.store = store; this.catalog = catalog; }
  createTask(tenant: string): Task {
    const task = { id: randomUUID(), tenant_id: tenant, epoch: 1, revision: 1 };
    this.store.db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(task.id, tenant, 1, 1); return task;
  }
  addIntent(task: Task, value: ReservationInput): void {
    const input = this.catalog.implementation.normalize(value);
    this.store.db.prepare('INSERT INTO intents VALUES(?,?,?,?,?,?)').run(input.intentRef, task.tenant_id, task.id,
      this.catalog.implementation.intentKey(task.tenant_id, input.intentRef), JSON.stringify(input), this.catalog.digest);
  }
  grant(taskId: string, allowedIntentRefs: readonly string[], scopes = ['reserve', 'read', 'cancel'], ttlMs = 600_000, runId?: string): string {
    return transaction(this.store.db, () => {
      const task = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as unknown as Task;
      if (!task) throw new DomainError('TASK_NOT_FOUND');
      if (!Array.isArray(allowedIntentRefs) || allowedIntentRefs.some(ref => typeof ref !== 'string' || !ref.length || ref.length > 160)) {
        throw new DomainError('INVALID_GRANT_INTENTS');
      }
      const refs = [...new Set(allowedIntentRefs)].sort();
      for (const ref of refs) {
        if (!this.store.db.prepare('SELECT 1 FROM intents WHERE tenant_id=? AND task_id=? AND ref=?').get(task.tenant_id, task.id, ref)) {
          throw new DomainError('INTENT_NOT_AUTHORIZED', 'Grant may only bind existing approved task intents', 403);
        }
      }
      if (runId) {
        const run = this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
        if (!run || run.task_id !== task.id || run.tenant_id !== task.tenant_id) throw new DomainError('RUN_NOT_FOUND');
        if (run.task_epoch !== task.epoch || !['ISSUED','RUNNING'].includes(String(run.state))) throw new DomainError('STALE_RUN');
        if (refs.some(ref => !JSON.parse(String(run.intents_json)).includes(ref)) || scopes.some(scope => !JSON.parse(String(run.scopes_json)).includes(scope))) {
          throw new DomainError('RUN_AUTHORITY_EXPANSION');
        }
      } else {
        runId = randomUUID();
        this.store.db.prepare(`INSERT INTO runs(id,tenant_id,task_id,task_epoch,state,intents_json,scopes_json,created_at)
          VALUES(?,?,?,?,'ISSUED',?,?,?)`).run(runId, task.tenant_id, task.id, task.epoch, JSON.stringify(refs), JSON.stringify(scopes), now(this.store.db));
      }
      const token = randomBytes(32).toString('base64url');
      this.store.db.prepare(`INSERT INTO grants(id,token_hash,tenant_id,task_id,run_id,task_epoch,expires_at,revoked,scopes_json,allowed_intent_refs_json)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), digest(token), task.tenant_id, task.id,
        runId, task.epoch, now(this.store.db) + ttlMs, 0, JSON.stringify(scopes), JSON.stringify(refs));
      return token;
    });
  }
  takeover(taskId: string, expectedEpoch: number): void {
    const changed = this.store.db.prepare('UPDATE tasks SET epoch=epoch+1 WHERE id=? AND epoch=?').run(taskId, expectedEpoch);
    if (Number(changed.changes) !== 1) throw new DomainError('TAKEOVER_CONFLICT');
  }
  revoke(token: string): void { this.store.db.prepare('UPDATE grants SET revoked=1 WHERE token_hash=?').run(digest(token)); }
  setEnabled(enabled: boolean): void { this.store.db.prepare("UPDATE settings SET value=? WHERE key='tool_enabled'").run(String(enabled)); }
}
