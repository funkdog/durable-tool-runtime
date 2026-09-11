import { randomUUID } from 'node:crypto';
import { Catalog, lookupSchema, cancelSchema } from './catalog.ts';
import { digest, now, transaction } from './db.ts';
import type { Store } from './store.ts';
import { DomainError, type Grant, type Intent, type Operation, type ReservationInput } from './types.ts';

export class Core {
  store: Store; catalog: Catalog;
  constructor(store: Store, catalog = new Catalog()) { this.store = store; this.catalog = catalog; }
  private allowsIntent(grant: Grant, ref: string): boolean {
    return (JSON.parse(grant.allowed_intent_refs_json) as string[]).includes(ref);
  }
  authenticate(token: string, scope?: string, write = false): Grant {
    const db = this.store.db;
    const grant = db.prepare('SELECT * FROM grants WHERE token_hash=?').get(digest(token)) as unknown as Grant | undefined;
    if (!grant || grant.revoked || grant.expires_at <= now(db)) throw new DomainError('UNAUTHORIZED', 'Invalid or expired grant', 401);
    if (scope && !(JSON.parse(grant.scopes_json) as string[]).includes(scope)) throw new DomainError('SCOPE_DENIED', 'Scope denied', 403);
    const task = db.prepare('SELECT epoch FROM tasks WHERE id=? AND tenant_id=?').get(grant.task_id, grant.tenant_id);
    if (!task) throw new DomainError('UNAUTHORIZED', 'Task missing', 401);
    if (write && task.epoch !== grant.task_epoch) throw new DomainError('STALE_TASK_EPOCH', 'Run has lost command authority', 403);
    if (write) {
      const run = db.prepare('SELECT managed,state FROM runs WHERE id=?').get(grant.run_id);
      if (run?.managed && (run.state !== 'RUNNING' || !db.prepare('SELECT 1 FROM scheduled_tasks WHERE task_id=? AND current_run_id=? AND state=\'ACTIVE\'').get(grant.task_id, grant.run_id))) {
        throw new DomainError('STALE_RUN', 'Run no longer owns this task', 403);
      }
    }
    return grant;
  }
  submit(token: string, value: unknown) {
    const input = this.catalog.implementation.normalize(value);
    return transaction(this.store.db, () => {
      const grant = this.authenticate(token, 'reserve', true);
      if (!this.allowsIntent(grant, input.intentRef)) throw new DomainError('INTENT_NOT_AUTHORIZED', 'Intent is not authorized by this grant', 403);
      if (this.store.db.prepare("SELECT value FROM settings WHERE key='tool_enabled'").get()?.value !== 'true') throw new DomainError('TOOL_DISABLED');
      const intent = this.store.db.prepare('SELECT * FROM intents WHERE tenant_id=? AND task_id=? AND ref=?')
        .get(grant.tenant_id, grant.task_id, input.intentRef) as unknown as Intent | undefined;
      if (!intent) throw new DomainError('INTENT_NOT_AUTHORIZED', 'Intent is not approved', 403);
      if (intent.definition_digest !== this.catalog.digest) throw new DomainError('DEFINITION_MISMATCH');
      this.catalog.implementation.authorize(input, JSON.parse(intent.input_json));
      const key = this.catalog.implementation.intentKey(grant.tenant_id, input.intentRef);
      const existing = this.store.db.prepare('SELECT id,args_hash,task_id FROM operations WHERE tenant_id=? AND intent_key=?').get(grant.tenant_id, key);
      if (existing) {
        if (existing.args_hash !== digest(input) || existing.task_id !== grant.task_id) throw new DomainError('INTENT_CONFLICT');
        return this.view(this.store.get(String(existing.id))!);
      }
      const id = this.insert(grant, input, key, intent.business_key, 'reserve');
      return this.view(this.store.get(id)!);
    });
  }
  private insert(grant: Grant, input: ReservationInput, key: string, businessKey: string, kind: 'reserve' | 'cancel', parent?: Operation): string {
    const id = randomUUID(); const at = now(this.store.db);
    this.store.db.prepare(`INSERT INTO operations(id,tenant_id,task_id,intent_ref,intent_key,business_key,args_hash,input_json,
      definition_digest,kind,parent_id,state,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'ACCEPTED',?,?)`)
      .run(id, grant.tenant_id, grant.task_id, input.intentRef, key, businessKey, digest(input), JSON.stringify(input),
        parent?.definition_digest ?? this.catalog.digest, kind, parent?.id ?? null, at, at);
    this.store.event(id, 'OperationAccepted'); return id;
  }
  private scoped(grant: Grant, id: string): Operation {
    const op = this.store.get(id);
    if (!op || op.tenant_id !== grant.tenant_id || op.task_id !== grant.task_id || !this.allowsIntent(grant, op.intent_ref)) {
      throw new DomainError('NOT_FOUND', 'Operation not found', 404);
    }
    return op;
  }
  get(token: string, value: unknown) {
    const query = lookupSchema.parse(value);
    if (Number(Boolean(query.operationId)) + Number(Boolean(query.intentRef)) !== 1) throw new DomainError('EXACTLY_ONE_LOOKUP_REQUIRED');
    const grant = this.authenticate(token, 'read');
    const id = query.operationId ?? this.store.db.prepare("SELECT id FROM operations WHERE tenant_id=? AND task_id=? AND intent_ref=? AND kind='reserve'")
      .get(grant.tenant_id, grant.task_id, query.intentRef!)?.id;
    if (!id) throw new DomainError('NOT_FOUND', 'Operation not found', 404);
    return this.view(this.scoped(grant, String(id)));
  }
  cancel(token: string, value: unknown) {
    const input = cancelSchema.parse(value);
    return transaction(this.store.db, () => {
      const grant = this.authenticate(token, 'cancel', true);
      const op = this.scoped(grant, input.operationId);
      if (op.kind !== 'reserve') throw new DomainError('CANNOT_CANCEL_COMPENSATION');
      if (op.desired_action === 'CANCEL') return this.view(op);
      const noDispatch = op.state === 'ACCEPTED';
      this.store.db.prepare(`UPDATE operations SET desired_action='CANCEL',state=?,state_version=state_version+1,
        next_attempt_at=?,lease_owner=?,lease_until=? WHERE id=?`)
        .run(noDispatch ? 'NOT_APPLIED' : op.state, noDispatch ? null : op.next_attempt_at,
          noDispatch ? null : op.lease_owner, noDispatch ? null : op.lease_until, op.id);
      this.store.event(op.id, noDispatch ? 'CancelledBeforeDispatch' : 'CancellationRequested', { reason: input.reason ?? null });
      if (!noDispatch && op.state !== 'NOT_APPLIED') this.insert(grant, JSON.parse(op.input_json), `${op.intent_key}/cancel`, op.business_key, 'cancel', op);
      return this.view(this.store.get(op.id)!);
    });
  }
  checkpoint(token: string) {
    return transaction(this.store.db, () => {
      const grant = this.authenticate(token, 'read');
      const ids = this.store.db.prepare("SELECT id,intent_ref FROM operations WHERE tenant_id=? AND task_id=? AND kind='reserve' ORDER BY id")
        .all(grant.tenant_id, grant.task_id).filter(row => this.allowsIntent(grant, String(row.intent_ref))).map(row => row.id);
      this.store.db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?,?,?,?)').run(grant.tenant_id, grant.task_id, grant.run_id, JSON.stringify(ids), now(this.store.db));
      return { taskId: grant.task_id, runId: grant.run_id, operationIds: ids };
    });
  }
  restoreCheckpoint(token: string, priorRunId: string) {
    const grant = this.authenticate(token, 'read');
    const row = this.store.db.prepare('SELECT operation_ids_json FROM checkpoints WHERE tenant_id=? AND task_id=? AND run_id=?')
      .get(grant.tenant_id, grant.task_id, priorRunId);
    if (!row) throw new DomainError('CHECKPOINT_NOT_FOUND');
    const visible = (JSON.parse(String(row.operation_ids_json)) as string[]).filter(id => {
      const op = this.store.get(id);
      return op && op.tenant_id === grant.tenant_id && op.task_id === grant.task_id && this.allowsIntent(grant, op.intent_ref);
    });
    return { priorRunId, operations: visible.map(id => this.view(this.scoped(grant, id))) };
  }
  view(op: Operation) {
    const child = this.store.db.prepare('SELECT * FROM operations WHERE parent_id=?').get(op.id) as unknown as Operation | undefined;
    const own = op.result_json ? JSON.parse(op.result_json) : null;
    const other = child?.result_json ? JSON.parse(child.result_json) : null;
    const observation = (other?.version ?? 0) > (own?.version ?? 0) ? other : own;
    return { operationId: op.id, intentRef: op.intent_ref, executionState: op.state, desiredAction: op.desired_action,
      stateVersion: op.state_version, executorEpoch: op.executor_epoch, blockedReason: op.blocked_reason, observation,
      cancellation: child ? { operationId: child.id, executionState: child.state, blockedReason: child.blocked_reason } : null };
  }
}
