import { randomUUID } from 'node:crypto';
import { now, transaction } from './db.ts';
import type { Store } from './store.ts';
import type { Operation, ExecutionState } from './types.ts';

const terminal = (op: Operation) => op.state === 'APPLIED' || op.state === 'NOT_APPLIED';
export class ExecutionStore {
  store: Store;
  constructor(store: Store) { this.store = store; }
  claim(worker: string, leaseMs = 1000): Operation | undefined {
    return transaction(this.store.db, () => {
      const at = now(this.store.db);
      const row = this.store.db.prepare(`SELECT id FROM operations WHERE state NOT IN ('APPLIED','NOT_APPLIED')
        AND blocked_reason IS NULL AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)
        ORDER BY CASE kind WHEN 'cancel' THEN 0 ELSE 1 END,created_at,id LIMIT 1`).get(at, at);
      if (!row) return undefined;
      const id = String(row.id);
      this.store.db.prepare('UPDATE operations SET executor_epoch=executor_epoch+1,lease_owner=?,lease_until=?,state_version=state_version+1 WHERE id=?').run(worker, at + leaseMs, id);
      this.store.event(id, 'ExecutorClaimed'); return this.store.get(id)!;
    });
  }
  owns(id: string, worker: string, epoch: number): boolean {
    const op = this.store.get(id);
    return Boolean(op && !terminal(op) && op.lease_owner === worker && op.executor_epoch === epoch && op.lease_until! > now(this.store.db));
  }
  renew(op: Operation, worker: string, leaseMs: number): boolean {
    const at = now(this.store.db);
    return Number(this.store.db.prepare(`UPDATE operations SET lease_until=? WHERE id=? AND lease_owner=? AND executor_epoch=? AND lease_until>?
      AND state NOT IN ('APPLIED','NOT_APPLIED')`).run(at + leaseMs, op.id, worker, op.executor_epoch, at).changes) === 1;
  }
  dispatch(op: Operation, worker: string): boolean {
    return transaction(this.store.db, () => {
      if (!this.owns(op.id, worker, op.executor_epoch)) return false;
      const current = this.store.get(op.id)!;
      if (current.kind === 'reserve' && current.desired_action === 'CANCEL') return false;
      this.store.db.prepare("UPDATE operations SET state='DISPATCH_RECORDED',state_version=state_version+1 WHERE id=?").run(op.id);
      this.store.event(op.id, 'DispatchRecorded'); return true;
    });
  }
  settle(op: Operation, worker: string, state: ExecutionState, evidence: unknown, blockedReason: string | null = null): boolean {
    return transaction(this.store.db, () => {
      if (!this.owns(op.id, worker, op.executor_epoch)) {
        this.store.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?)')
          .run(randomUUID(), op.id, op.executor_epoch, JSON.stringify({ worker, proposedState: state, evidence, rejected: 'STALE_EXECUTOR' }), now(this.store.db));
        return false;
      }
      this.store.db.prepare(`UPDATE operations SET state=?,result_json=?,blocked_reason=?,lease_owner=NULL,lease_until=NULL,
        next_attempt_at=?,state_version=state_version+1 WHERE id=?`)
        .run(state, evidence ? JSON.stringify(evidence) : null, blockedReason,
          state === 'OUTCOME_UNKNOWN' && !blockedReason ? now(this.store.db) + 200 : null, op.id);
      this.store.event(op.id, blockedReason ? 'RequiresOperator' : 'OutcomeRecorded'); return true;
    });
  }
}
