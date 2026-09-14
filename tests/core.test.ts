import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunDirectory } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { Controller } from '../src/controller.ts';
import { Core } from '../src/core.ts';
import { DomainError } from '../src/types.ts';
const input = { intentRef: 'line-1-v1', warehouseId: 'wh', sku: 'A', quantity: 3 };

test('duplicate admissions resolve to one durable operation', () => {
  const store = new Store(createRunDirectory());
  try {
    const controller = new Controller(store); const task = controller.createTask('tenant');
    controller.addIntent(task, input); const token = controller.grant(task.id, [input.intentRef]); const core = new Core(store);
    const a = core.submit(token, input); const b = core.submit(token, input);
    assert.equal(a.operationId, b.operationId);
    assert.equal(store.snapshot().operations.length, 1);
  } finally { store.close(); }
});
test('task takeover rejects old producer without invalidating accepted operation', () => {
  const store = new Store(createRunDirectory());
  try {
    const controller = new Controller(store); const task = controller.createTask('tenant');
    controller.addIntent(task, input); const old = controller.grant(task.id, [input.intentRef]); const core = new Core(store);
    const accepted = core.submit(old, input); controller.takeover(task.id, 1);
    assert.throws(() => core.submit(old, input), (e) => e instanceof DomainError && e.code === 'STALE_TASK_EPOCH');
    assert.equal(core.submit(controller.grant(task.id, [input.intentRef]), input).operationId, accepted.operationId);
  } finally { store.close(); }
});
test('operation, event and outbox are committed together or none survive', () => {
  const store = new Store(createRunDirectory());
  try {
    const controller = new Controller(store); const task = controller.createTask('tenant');
    controller.addIntent(task, input); const token = controller.grant(task.id, [input.intentRef]); const core = new Core(store);
    const event = store.event.bind(store);
    store.event = (...args) => { event(...args); throw new Error('Injected pre-commit crash'); };
    assert.throws(() => core.submit(token, input), /Injected pre-commit crash/);
    assert.equal(store.snapshot().operations.length, 0); assert.equal(store.snapshot().events.length, 0);
    assert.equal(store.db.prepare('SELECT * FROM outbox').all().length, 0);
    store.event = event;
    assert.equal(core.submit(token, input).executionState, 'ACCEPTED');
  } finally { store.close(); }
});
test('duplicate/out-of-order event delivery never regresses the read projection', () => {
  const store = new Store(createRunDirectory());
  try {
    const controller = new Controller(store); const task = controller.createTask('tenant');
    controller.addIntent(task, input); const token = controller.grant(task.id, [input.intentRef]); const core = new Core(store);
    const accepted = core.submit(token, input); core.cancel(token, { operationId: accepted.operationId });
    const events = store.snapshot().events;
    const newer = String(events.find(e => e.type === 'CancelledBeforeDispatch')!.id);
    const older = String(events.find(e => e.type === 'OperationAccepted')!.id);
    assert.equal(store.deliver('ui', newer), true); assert.equal(store.deliver('ui', newer), false); assert.equal(store.deliver('ui', older), true);
    assert.equal(JSON.parse(String(store.snapshot().projections[0].payload)).state, 'NOT_APPLIED');
    assert.equal(store.snapshot().deliveries.length, 2);
  } finally { store.close(); }
});
