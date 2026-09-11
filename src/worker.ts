import { Catalog } from './catalog.ts';
import { ExecutionStore } from './execution-store.ts';
import type { Store } from './store.ts';
import type { BackendClient } from './backend.ts';
import type { Operation, BusinessRequest, Capabilities } from './types.ts';

export function businessRequest(op: Operation): BusinessRequest {
  const input = JSON.parse(op.input_json);
  return { intentKey: op.business_key, argsHash: op.args_hash, tenantId: op.tenant_id,
    warehouseId: input.warehouseId, sku: input.sku, quantity: input.quantity };
}
export class Worker {
  store: Store; execution: ExecutionStore; backend: BackendClient; id: string; leaseMs: number; catalog: Catalog;
  constructor(store: Store, backend: BackendClient, id: string, leaseMs = 1000, catalog = new Catalog()) {
    this.store = store; this.execution = new ExecutionStore(store); this.backend = backend; this.id = id; this.leaseMs = leaseMs; this.catalog = catalog;
  }
  async tick(): Promise<boolean> {
    const op = this.execution.claim(this.id, this.leaseMs); if (!op) return false;
    const heartbeat = setInterval(() => { try { this.execution.renew(op, this.id, this.leaseMs); } catch { /* expiry fails closed at finalization */ } }, this.leaseMs / 3);
    try {
      if (op.definition_digest !== this.catalog.digest) { this.park(op, 'IMPLEMENTATION_UNAVAILABLE'); return true; }
      if (op.executor_epoch > 6) { this.park(op, 'RETRY_BUDGET_EXHAUSTED'); return true; }
      const caps = await this.backend.capabilities();
      await this.execute(op, caps);
    } catch {
      // Transport failure is not proof of business failure. No automatic terminal success/failure.
      this.execution.settle(op, this.id, 'OUTCOME_UNKNOWN', null);
    } finally { clearInterval(heartbeat); }
    return true;
  }
  private park(op: Operation, reason: string): void { this.execution.settle(op, this.id, 'OUTCOME_UNKNOWN', null, reason); }
  private async execute(op: Operation, caps: Capabilities) {
    const request = businessRequest(op);
    const record = (raw: unknown) => {
      const result = this.catalog.implementation.classify(request, raw, op.kind);
      if (result.state === 'OUTCOME_UNKNOWN') return false;
      this.execution.settle(op, this.id, result.state, result.observation); return true;
    };
    if (op.state !== 'ACCEPTED') {
      if (!caps.inspect) { this.park(op, 'RECONCILIATION_UNSUPPORTED'); return; }
      if (record(await this.backend.call('/inspect', request))) return;
      if (!caps.idempotent) { this.park(op, 'SAFE_RETRY_UNSUPPORTED'); return; }
    }
    const current = this.store.get(op.id)!;
    if (current.kind === 'reserve' && current.desired_action === 'CANCEL') {
      this.execution.settle(op, this.id, 'OUTCOME_UNKNOWN', null); return;
    }
    if (op.kind === 'cancel' && !caps.cancel) { this.park(op, 'CANCELLATION_UNSUPPORTED'); return; }
    if (!this.execution.dispatch(op, this.id)) return;
    const raw = await this.backend.call(op.kind === 'cancel' ? '/cancel' : '/reserve', request);
    if (!record(raw)) this.park(op, 'INCONCLUSIVE_EVIDENCE');
  }
}
