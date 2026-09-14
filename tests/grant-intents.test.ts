import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.ts';
import { DomainError } from '../src/types.ts';
import { createRunDirectory, openDatabase } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { Core } from '../src/core.ts';

const input = { intentRef: 'intent-A', warehouseId: 'w', sku: 's', quantity: 1 };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

test('grant issued for A cannot submit a future intent B in the same task', async () => {
  const h = new Harness();
  try {
    const f = h.setup(input); const b = { ...input, intentRef: 'intent-B' };
    h.controller.addIntent(f.task, b);
    assert.throws(() => h.core.submit(f.token, b), code('INTENT_NOT_AUTHORIZED'));
    assert.equal(h.store.snapshot().operations.length, 0);
    assert.equal(h.store.snapshot().events.length, 0);
    assert.equal(h.inventory.snapshot().effects.length, 0);
  } finally { await h.close(); }
});
test('old grant cannot cancel or read an operation for a future same-task intent', async () => {
  const h = new Harness();
  try {
    const f = h.setup(input); const b = { ...input, intentRef: 'intent-B' }; h.controller.addIntent(f.task, b);
    const tokenB = h.controller.grant(f.task.id, [b.intentRef]); const opB = h.core.submit(tokenB, b);
    assert.throws(() => h.core.cancel(f.token, { operationId: opB.operationId }), code('NOT_FOUND'));
    assert.throws(() => h.core.get(f.token, { operationId: opB.operationId }), code('NOT_FOUND'));
    assert.throws(() => h.core.get(f.token, { intentRef: b.intentRef }), code('NOT_FOUND'));
    assert.equal(h.store.get(opB.operationId)?.desired_action, 'CONTINUE');
  } finally { await h.close(); }
});
test('checkpoint does not expand old grant visibility to a later intent', async () => {
  const h = new Harness();
  try {
    const f = h.setup(input); const opA = h.core.submit(f.token, input);
    const b = { ...input, intentRef: 'intent-B' }; h.controller.addIntent(f.task, b);
    const tokenB = h.controller.grant(f.task.id, [input.intentRef, b.intentRef]); h.core.submit(tokenB, b);
    assert.deepEqual(h.core.checkpoint(f.token).operationIds, [opA.operationId]);
    const broadCheckpoint = h.core.checkpoint(tokenB);
    assert.deepEqual(h.core.restoreCheckpoint(f.token, broadCheckpoint.runId).operations.map(op => op.operationId), [opA.operationId]);
  } finally { await h.close(); }
});
test('two grants for existing disjoint intents stay isolated across reopen and repeated cancellation', async () => {
  const h = new Harness();
  try {
    const f = h.setup(input); const b = { ...input, intentRef: 'intent-B' }; h.controller.addIntent(f.task, b);
    const tokenA = h.controller.grant(f.task.id, [input.intentRef]); const tokenB = h.controller.grant(f.task.id, [b.intentRef]);
    const reopened = new Store(h.dir);
    try {
      const core = new Core(reopened);
      const a = core.submit(tokenA, input); const opB = core.submit(tokenB, b);
      assert.throws(() => core.submit(tokenA, b), code('INTENT_NOT_AUTHORIZED'));
      assert.throws(() => core.submit(tokenB, input), code('INTENT_NOT_AUTHORIZED'));
      assert.equal(core.get(tokenA, { intentRef: input.intentRef }).operationId, a.operationId);
      assert.equal(core.get(tokenB, { operationId: opB.operationId }).operationId, opB.operationId);
      for (const [token, target] of [[tokenA, opB.operationId], [tokenB, a.operationId]]) {
        assert.throws(() => core.cancel(token, { operationId: target }), code('NOT_FOUND'));
        assert.throws(() => core.get(token, { operationId: target }), code('NOT_FOUND'));
      }
      core.cancel(tokenB, { operationId: opB.operationId });
      assert.throws(() => core.cancel(tokenA, { operationId: opB.operationId }), code('NOT_FOUND'));
      assert.equal(core.submit(tokenB, b).operationId, opB.operationId);
      assert.equal(core.get(tokenB, { operationId: opB.operationId }).executionState, 'NOT_APPLIED');
      assert.equal(h.store.snapshot().operations.length, 2);
    } finally { reopened.close(); }
  } finally { await h.close(); }
});
test('issuer requires explicit existing task intents and snapshots an immutable set', async () => {
  const h = new Harness();
  try {
    const f = h.setup(input); const refs = [input.intentRef];
    const token = h.controller.grant(f.task.id, refs); refs.push('intent-B');
    assert.throws(() => Reflect.apply(h.controller.grant, h.controller, [f.task.id]), code('INVALID_GRANT_INTENTS'));
    assert.throws(() => h.controller.grant(f.task.id, ['intent-B']), code('INTENT_NOT_AUTHORIZED'));
    const other = h.controller.createTask(f.task.tenant_id); h.controller.addIntent(other, { ...input, intentRef: 'foreign-task' });
    assert.throws(() => h.controller.grant(f.task.id, ['foreign-task']), code('INTENT_NOT_AUTHORIZED'));
    const grant = h.core.authenticate(token);
    assert.deepEqual(JSON.parse(grant.allowed_intent_refs_json), [input.intentRef]);
    assert.throws(() => h.store.db.prepare('UPDATE grants SET allowed_intent_refs_json=? WHERE id=?').run(JSON.stringify(refs), grant.id), /GRANT_INTENTS_IMMUTABLE/);
    const empty = h.controller.grant(f.task.id, []);
    assert.throws(() => h.core.submit(empty, input), code('INTENT_NOT_AUTHORIZED'));
    assert.deepEqual(h.core.checkpoint(empty).operationIds, []);
    h.controller.revoke(token); assert.throws(() => h.core.authenticate(token), code('UNAUTHORIZED'));
  } finally { await h.close(); }
});
test('legacy grant schema fails closed without altering retained evidence', () => {
  const dir = createRunDirectory(); const db = openDatabase(dir, 'governance');
  db.exec("CREATE TABLE grants(id TEXT PRIMARY KEY); INSERT INTO grants VALUES('legacy-record');"); db.close();
  assert.throws(() => new Store(dir), /INCOMPATIBLE_GRANT_SCHEMA/);
  const evidence = openDatabase(dir, 'governance');
  try {
    assert.deepEqual(evidence.prepare('PRAGMA table_info(grants)').all().map(row => row.name), ['id']);
    assert.equal(evidence.prepare('SELECT id FROM grants').get()!.id, 'legacy-record');
  } finally { evidence.close(); }
});
test('real MCP preserves grant-intent isolation after discovery on two gateways', async () => {
  const h = new Harness();
  try {
    await h.start(); const f = h.setup(input); const a = await h.client(f.token);
    assert.equal((await a.listTools()).tools.length, 3);
    const b = { ...input, intentRef: 'intent-B' }; h.controller.addIntent(f.task, b);
    const denied = await h.call(a, 'inventory_reservation_submit', b);
    assert.equal(denied.error, true); assert.equal(denied.data.code, 'INTENT_NOT_AUTHORIZED');
    assert.equal(h.store.snapshot().operations.length, 0);
    const clientB = await h.client(h.controller.grant(f.task.id, [b.intentRef]), 1);
    const accepted = await h.call(clientB, 'inventory_reservation_submit', b); assert.equal(accepted.error, false);
    for (const name of ['operation_get', 'operation_cancel_request']) {
      const result = await h.call(a, name, { operationId: accepted.data.operationId });
      assert.equal(result.error, true); assert.equal(result.data.code, 'NOT_FOUND');
    }
    assert.equal((await h.call(clientB, 'operation_get', { intentRef: b.intentRef })).data.operationId, accepted.data.operationId);
    assert.equal((await h.call(clientB, 'operation_cancel_request', { operationId: accepted.data.operationId })).data.executionState, 'NOT_APPLIED');
    assert.equal(h.inventory.snapshot().effects.length, 0);
  } finally { await h.close(); }
});
