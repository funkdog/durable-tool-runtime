import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harness, until } from '../src/harness.ts';
import { Store } from '../src/store.ts';
import { Core } from '../src/core.ts';
import { Worker } from '../src/worker.ts';
import { BackendClient } from '../src/backend.ts';

test('checkpoint restores references and fresh facts, never old authority', async () => {
  const h = new Harness();
  try {
    const f = h.setup({ intentRef: 'checkpoint', warehouseId: 'w', sku: 's', quantity: 1 });
    const op = h.core.submit(f.token, f.input); const cp = h.core.checkpoint(f.token);
    h.controller.takeover(f.task.id, 1); const token = h.controller.grant(f.task.id, [f.input.intentRef]);
    h.core.cancel(token, { operationId: op.operationId });
    const reopened = new Store(h.dir);
    try {
      const core = new Core(reopened); const restore = core.restoreCheckpoint(token, cp.runId);
      assert.equal(restore.operations[0].executionState, 'NOT_APPLIED');
      assert.throws(() => core.submit(f.token, f.input), /lost command authority/);
      const other = h.controller.createTask('other');
      assert.throws(() => core.restoreCheckpoint(h.controller.grant(other.id, []), cp.runId), /CHECKPOINT_NOT_FOUND/);
    } finally { reopened.close(); }
  } finally { await h.close(); }
});
test('gateway restart does not lose accepted work or require an MCP session id', async () => {
  const h = new Harness();
  try {
    await h.start(); const f = h.setup({ intentRef: 'restart', warehouseId: 'w', sku: 's', quantity: 1 });
    const c = await h.client(f.token); const accepted = await h.call(c, 'inventory_reservation_submit', f.input);
    await c.close(); await h.kill(h.children.find(c => c.role === 'gateway')!, 'SIGKILL');
    const replacement = await h.process('gateway'); h.gatewayUrls[0] = replacement.url!;
    const next = await h.client(f.token); await h.process('worker');
    await until(() => h.store.get(accepted.data.operationId)?.state === 'APPLIED');
    const result = await h.call(next, 'operation_get', { intentRef: f.input.intentRef });
    assert.equal(result.data.operationId, accepted.data.operationId);
    assert.equal(result.data.executionState, 'APPLIED');
  } finally { await h.close(); }
});
test('missing pinned implementation and retry budget both stop before any downstream request', async () => {
  const h = new Harness();
  try {
    const f = h.setup({ intentRef: 'pin', warehouseId: 'w', sku: 's', quantity: 1 });
    const accepted = h.core.submit(f.token, f.input);
    const backend = new BackendClient('http://127.0.0.1:1', 'unused'); let calls = 0;
    backend.capabilities = async () => { calls++; throw new Error('Must not reach backend'); };
    h.store.db.prepare('UPDATE operations SET definition_digest=? WHERE id=?').run('missing-version', accepted.operationId);
    await new Worker(h.store, backend, 'one').tick();
    assert.equal(h.store.get(accepted.operationId)?.blocked_reason, 'IMPLEMENTATION_UNAVAILABLE');
    const second = { ...f.input, intentRef: 'budget' }; h.controller.addIntent(f.task, second);
    const retry = h.core.submit(h.controller.grant(f.task.id, [second.intentRef]), second);
    h.store.db.prepare('UPDATE operations SET executor_epoch=6 WHERE id=?').run(retry.operationId);
    await new Worker(h.store, backend, 'two').tick();
    assert.equal(h.store.get(retry.operationId)?.blocked_reason, 'RETRY_BUDGET_EXHAUSTED');
    assert.equal(calls, 0);
  } finally { await h.close(); }
});
test('different intents on competing workers cannot oversell the same stock', async () => {
  const h = new Harness();
  try {
    await h.start(); const f = h.setup({ intentRef: 'compete-1', warehouseId: 'w', sku: 's', quantity: 6 });
    const second = { ...f.input, intentRef: 'compete-2' }; h.controller.addIntent(f.task, second);
    const c1 = await h.client(f.token); const c2 = await h.client(h.controller.grant(f.task.id, [second.intentRef]), 1);
    const ops = await Promise.all([h.call(c1, 'inventory_reservation_submit', f.input), h.call(c2, 'inventory_reservation_submit', second)]);
    await Promise.all([h.process('worker'), h.process('worker')]);
    await until(() => ops.every(o => ['APPLIED', 'NOT_APPLIED'].includes(h.store.get(o.data.operationId)!.state)));
    assert.deepEqual(ops.map(o => h.store.get(o.data.operationId)!.state).sort(), ['APPLIED', 'NOT_APPLIED']);
    assert.equal(h.inventory.stock('demo-tenant', 'w', 's'), 4);
    assert.equal(h.inventory.snapshot().effects.filter(e => e.kind === 'reserve').length, 1);
  } finally { await h.close(); }
});
