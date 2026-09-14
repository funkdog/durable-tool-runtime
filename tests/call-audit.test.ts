import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.ts';
import { CallAudit } from '../src/call-audit.ts';
test('MCP audit binds actual call to grant/run without copying bearer secrets', async () => {
  const h = new Harness(); const audit = new CallAudit(h.store);
  try {
    await h.start(); const f = h.setup({ intentRef: 'audit', warehouseId: 'w', sku: 's', quantity: 1 });
    const c = await h.client(f.token); await h.call(c, 'inventory_reservation_submit', f.input);
    const rows = audit.list(); assert.equal(rows.length, 1);
    assert.equal(rows[0].run_id, h.core.authenticate(f.token).run_id);
    assert.equal(rows[0].tool, 'inventory_reservation_submit');
    assert.ok(rows[0].completed_at! >= rows[0].started_at);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(f.token));
  } finally { await h.close(); }
});
