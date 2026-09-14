import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, definition } from '../src/catalog.ts';
import { Harness, until } from '../src/harness.ts';
import { businessRequest } from '../src/worker.ts';
import { DomainError } from '../src/types.ts';

test('business ref cannot collide with a compensation namespace', () => {
  const catalog = new Catalog(); const key = catalog.implementation.intentKey('t', 'a');
  assert.notEqual(catalog.implementation.intentKey('t', 'a/cancel'), `${key}/cancel`);
});
test('unknown executable refs and mismatched evidence fail closed', () => {
  assert.throws(() => new Catalog({ ...definition, implementationRef: 'https://evil/code.js' }), /UNSUPPORTED_DEFINITION/);
  const request = { tenantId: 't', intentKey: 'k', argsHash: 'h', warehouseId: 'w', sku: 's', quantity: 1 };
  const classify = new Catalog().implementation.classify;
  assert.throws(() => classify(request, { ...request, found: true, state: 'RESERVED' }, 'reserve'), /INCOMPLETE_EVIDENCE/);
  assert.throws(() => classify(request, { ...request, tenantId: 'other', found: false }, 'reserve'), /EVIDENCE_MISMATCH/);
});
test('tenant/task scope, intent binding, revocation and tool disable are enforced in Core', () => {
  const h = new Harness();
  try {
    const f = h.setup({ intentRef: 'i', warehouseId: 'w', sku: 's', quantity: 1 });
    const original = h.core.submit(f.token, f.input);
    assert.throws(() => h.core.submit(f.token, { ...f.input, quantity: 2 }), /INTENT_ARGUMENT_MISMATCH/);
    const other = h.controller.createTask('other'); const otherToken = h.controller.grant(other.id, []);
    assert.throws(() => h.core.get(otherToken, { operationId: original.operationId }), /Operation not found/);
    const sameTenant = h.controller.createTask(f.task.tenant_id);
    assert.throws(() => h.core.get(h.controller.grant(sameTenant.id, []), { operationId: original.operationId }), /Operation not found/);
    const reader = h.controller.grant(f.task.id, [f.input.intentRef], ['read']);
    assert.throws(() => h.core.submit(reader, f.input), (e) => e instanceof DomainError && e.code === 'SCOPE_DENIED');
    h.controller.setEnabled(false); assert.throws(() => h.core.submit(f.token, f.input), /TOOL_DISABLED/);
    assert.equal(h.core.get(f.token, { operationId: original.operationId }).operationId, original.operationId);
    h.controller.revoke(f.token); assert.throws(() => h.core.get(f.token, { operationId: original.operationId }), /Invalid or expired grant/);
    assert.throws(() => h.core.get(h.controller.grant(f.task.id, [f.input.intentRef], ['read'], -1), { operationId: original.operationId }), /Invalid or expired grant/);
    assert.throws(() => h.core.get(reader, {}), /EXACTLY_ONE_LOOKUP_REQUIRED/);
  } finally { h.store.close(); h.inventory.close(); }
});
test('MCP blocks unauthenticated callers, hostile Origin and missing scopes', async () => {
  const h = new Harness();
  try {
    await h.start(); const f = h.setup({ intentRef: 'auth', warehouseId: 'w', sku: 's', quantity: 1 });
    const url = h.gatewayUrls[0] + '/mcp';
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, Origin: 'https://evil.example' } })).status, 403);
    const client = await h.client(h.controller.grant(f.task.id, [f.input.intentRef], ['read']));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['operation_get']);
    assert.equal((await client.callTool({ name: 'inventory_reservation_submit', arguments: f.input as unknown as Record<string, unknown> })).isError, true);
  } finally { await h.close(); }
});
test('cancel closes an intent before a held in-flight reserve reaches its side-effect boundary', { timeout: 20000 }, async () => {
  const h = new Harness();
  try {
    await h.start(); const f = h.setup({ intentRef: 'late', warehouseId: 'w', sku: 's', quantity: 3 });
    const c = await h.client(f.token); const accepted = await h.call(c, 'inventory_reservation_submit', f.input);
    const op = h.store.get(accepted.data.operationId)!;
    h.inventory.armFault('before_apply', op.business_key, 'hold');
    await h.process('worker'); await until(() => h.inventory.fault('before_apply')?.hits === 1);
    await h.call(c, 'operation_cancel_request', { operationId: op.id }); await h.process('worker');
    await until(() => h.core.view(h.store.get(op.id)!).cancellation?.executionState === 'APPLIED');
    h.inventory.releaseFault('before_apply');
    await until(() => h.store.get(op.id)?.state === 'NOT_APPLIED');
    assert.equal(h.inventory.inspect(businessRequest(op)).state, 'CANCELLED');
    assert.equal(h.inventory.stock('demo-tenant', 'w', 's'), 10);
    assert.equal(h.inventory.effectCount(op.business_key, 'reserve'), 0);
  } finally { await h.close(); }
});
test('a weak backend parks unknown after a dropped response instead of claiming safe retry', { timeout: 20000 }, async () => {
  const h = new Harness();
  try {
    await h.start('weak'); const f = h.setup({ intentRef: 'weak', warehouseId: 'w', sku: 's', quantity: 3 });
    const accepted = h.core.submit(f.token, f.input); const op = h.store.get(accepted.operationId)!;
    h.inventory.armFault('after_commit_before_response', op.business_key, 'drop'); await h.process('worker');
    await until(() => h.store.get(op.id)?.blocked_reason === 'RECONCILIATION_UNSUPPORTED');
    assert.equal(h.store.get(op.id)?.state, 'OUTCOME_UNKNOWN');
    assert.equal(h.inventory.effectCount(op.business_key, 'reserve'), 1);
    assert.equal(h.store.get(op.id)?.next_attempt_at, null);
  } finally { await h.close(); }
});
test('irreversible consumption rejects compensation without rewriting original success', { timeout: 20000 }, async () => {
  const h = new Harness();
  try {
    await h.start(); const f = h.setup({ intentRef: 'consumed', warehouseId: 'w', sku: 's', quantity: 3 });
    const accepted = h.core.submit(f.token, f.input); await h.process('worker');
    await until(() => h.store.get(accepted.operationId)?.state === 'APPLIED');
    const op = h.store.get(accepted.operationId)!; h.inventory.consume(businessRequest(op));
    h.core.cancel(f.token, { operationId: op.id });
    await until(() => h.core.view(h.store.get(op.id)!).cancellation?.executionState === 'NOT_APPLIED');
    assert.equal(h.inventory.stock('demo-tenant', 'w', 's'), 7);
    assert.equal(h.core.view(h.store.get(op.id)!).observation.state, 'CONSUMED');
  } finally { await h.close(); }
});
