import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harness, until } from '../src/harness.ts';

test('final snapshot includes an in-flight worker completing during shutdown', { timeout: 15000 }, async () => {
  const h = new Harness();
  try {
    await h.start(); const f = h.setup({ intentRef:'drain',warehouseId:'w',sku:'s',quantity:3 });
    const op = h.core.submit(f.token,f.input);
    h.inventory.armFault('after_commit_before_response',h.store.get(op.operationId)!.business_key,'hold');
    await h.process('worker');
    await until(()=>h.inventory.fault('after_commit_before_response')?.hits===1);
    assert.equal(h.store.get(op.operationId)!.state,'DISPATCH_RECORDED');
    const pending = h.finalSnapshot();
    h.inventory.releaseFault('after_commit_before_response');
    const result = await pending;
    assert.equal(h.store.get(op.operationId)!.state,'APPLIED');
    assert.equal(result.governance.operations[0].state,'APPLIED');
    assert.equal(result.inventory.stock[0].available,7);
    assert.ok(h.children.every(child=>child.child.exitCode!==null||child.child.signalCode!==null));
  } finally { await h.close(); }
});
