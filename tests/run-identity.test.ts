import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunDirectory } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { Core } from '../src/core.ts';
import { Controller } from '../src/controller.ts';

test('rotating a grant for an existing run preserves execution identity across database reopen', () => {
  const dir = createRunDirectory(); let store = new Store(dir);
  try {
    const controller = new Controller(store); const core = new Core(store);
    const task = controller.createTask('tenant');
    const input = { intentRef: 'identity', warehouseId: 'w', sku: 's', quantity: 1 };
    controller.addIntent(task, input);
    const first = core.authenticate(controller.grant(task.id, [input.intentRef]));
    store.close(); store = new Store(dir);
    const nextController = new Controller(store);
    // Additional binding must not silently mint a different execution identity.
    const next = new Core(store).authenticate(nextController.grant(task.id, [input.intentRef], ['read'], 600_000, first.run_id));
    assert.equal(next.run_id, first.run_id);
    assert.notEqual(next.id, first.id);
    assert.throws(() => nextController.grant(task.id, [input.intentRef], ['read'], 600_000, 'missing'), /RUN_NOT_FOUND/);
  } finally { store.close(); }
});

test('persisted run authority cannot be expanded after issuance', () => {
  const store = new Store(createRunDirectory());
  try {
    const controller = new Controller(store); const task = controller.createTask('tenant');
    const token = controller.grant(task.id, [], ['read']); const run = new Core(store).authenticate(token).run_id;
    assert.throws(() => store.db.prepare('UPDATE runs SET scopes_json=? WHERE id=?').run('["read","reserve"]', run), /IMMUTABLE_RUN_PLAN/);
  } finally { store.close(); }
});
