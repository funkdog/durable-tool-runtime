import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunDirectory } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { Controller } from '../src/controller.ts';
import { Core } from '../src/core.ts';
import { ExecutionStore } from '../src/execution-store.ts';
const input = { intentRef: 'line-1', warehouseId: 'wh', sku: 'A', quantity: 3 };
function fixture() {
  const store = new Store(createRunDirectory()); const controller = new Controller(store);
  const task = controller.createTask('tenant'); controller.addIntent(task, input);
  const token = controller.grant(task.id, [input.intentRef]); const core = new Core(store);
  const op = core.submit(token, input); return { store, controller, task, token, core, op, exec: new ExecutionStore(store) };
}
test('stale executor cannot finalize after another executor claims', () => {
  const f = fixture();
  try {
    const a = f.exec.claim('A')!; assert.ok(f.exec.dispatch(a, 'A'));
    f.store.db.prepare('UPDATE operations SET lease_until=0 WHERE id=?').run(a.id); // deterministic lease expiry, fixture only
    const b = f.exec.claim('B')!; assert.equal(b.executor_epoch, a.executor_epoch + 1);
    assert.equal(f.exec.settle(a, 'A', 'APPLIED', { stale: true }), false);
    assert.equal(f.store.get(a.id)?.lease_owner, 'B');
    assert.equal(f.store.get(a.id)?.state, 'DISPATCH_RECORDED');
    assert.equal(f.store.snapshot().observations.length, 1);
    assert.equal(f.exec.settle(b, 'B', 'APPLIED', { receipt: true }), true);
  } finally { f.store.close(); }
});
test('cancel before dispatch prevents a claimed worker from calling downstream', () => {
  const f = fixture();
  try {
    const a = f.exec.claim('A')!;
    assert.equal(f.core.cancel(f.token, { operationId: a.id }).executionState, 'NOT_APPLIED');
    assert.equal(f.exec.dispatch(a, 'A'), false);
    assert.equal(f.store.snapshot().operations.length, 1);
  } finally { f.store.close(); }
});
