import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harness, until } from '../src/harness.ts';

test('real MCP + two gateways + killed worker recover committed effect once and compensate once', { timeout: 25000 }, async () => {
  const h = new Harness();
  try {
    await h.start(); const f = h.setup({ intentRef: 'order-42-line-1-v1', warehouseId: 'wh', sku: 'A', quantity: 3 });
    const c1 = await h.client(f.token); const c2 = await h.client(f.token, 1);
    assert.equal((await c1.listTools()).tools.length, 3);
    const [a, b] = await Promise.all([h.call(c1, 'inventory_reservation_submit', f.input), h.call(c2, 'inventory_reservation_submit', f.input)]);
    assert.equal(a.error, false); assert.equal(a.data.operationId, b.data.operationId);
    const id = a.data.operationId; const op = h.store.get(id)!;
    h.inventory.armFault('after_commit_before_response', op.business_key, 'hold');
    const worker = await h.process('worker');
    await until(() => h.inventory.fault('after_commit_before_response')?.hits === 1);
    assert.equal(h.inventory.stock('demo-tenant', 'wh', 'A'), 7);
    assert.equal(h.store.get(id)?.state, 'DISPATCH_RECORDED');
    await h.kill(worker, 'SIGKILL'); await h.process('worker');
    await until(() => h.store.get(id)?.state === 'APPLIED');
    assert.equal(h.inventory.effectCount(op.business_key, 'reserve'), 1);
    assert.ok(h.store.get(id)!.executor_epoch >= 2);
    h.controller.takeover(f.task.id, 1);
    assert.equal((await h.call(c1, 'inventory_reservation_submit', f.input)).data.code, 'STALE_TASK_EPOCH');
    const c3 = await h.client(h.controller.grant(f.task.id, [f.input.intentRef]));
    assert.equal((await h.call(c3, 'operation_get', { intentRef: f.input.intentRef })).data.operationId, id);
    await h.call(c3, 'operation_cancel_request', { operationId: id });
    await until(() => h.core.view(h.store.get(id)!).cancellation?.executionState === 'APPLIED');
    await h.call(c3, 'operation_cancel_request', { operationId: id });
    assert.equal(h.inventory.stock('demo-tenant', 'wh', 'A'), 10);
    assert.equal(h.inventory.effectCount(op.business_key, 'release'), 1);
    assert.equal(h.store.get(id)?.state, 'APPLIED'); // history is not rewritten as "never happened"
    assert.equal(h.core.view(h.store.get(id)!).observation.state, 'RELEASED');
    h.inventory.releaseFault('after_commit_before_response');
    const eventId = String(h.store.snapshot().events[0].id);
    assert.equal(h.store.deliver('projection', eventId), true); assert.equal(h.store.deliver('projection', eventId), false);
  } finally { await h.close(); }
});
