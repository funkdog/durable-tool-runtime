import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunDirectory } from '../src/db.ts';
import { Inventory } from '../src/inventory.ts';
import type { BusinessRequest } from '../src/types.ts';

const request: BusinessRequest = { intentKey: 'tenant/reserve/order-1/v1', argsHash: 'hash-3', tenantId: 'tenant', warehouseId: 'wh', sku: 'A', quantity: 3 };

test('reserve once, release once, and never resurrect a closed intent', () => {
  const inventory = new Inventory(createRunDirectory());
  try {
    inventory.seed('tenant', 'wh', 'A', 10);
    const first = inventory.reserve(request);
    assert.equal(first.state, 'RESERVED');
    assert.equal(inventory.stock('tenant', 'wh', 'A'), 7);
    assert.equal(inventory.reserve(request).receiptId, first.receiptId);
    assert.equal(inventory.effectCount(request.intentKey, 'reserve'), 1);
    assert.equal(inventory.cancel(request).state, 'RELEASED');
    inventory.cancel(request);
    assert.equal(inventory.stock('tenant', 'wh', 'A'), 10);
    assert.equal(inventory.effectCount(request.intentKey, 'release'), 1);
    assert.equal(inventory.reserve(request).state, 'RELEASED');
    assert.equal(inventory.stock('tenant', 'wh', 'A'), 10);
  } finally { inventory.close(); }
});

test('cancel before apply creates an authoritative tombstone', () => {
  const inventory = new Inventory(createRunDirectory());
  try {
    inventory.seed('tenant', 'wh', 'A', 10);
    assert.equal(inventory.cancel(request).state, 'CANCELLED');
    assert.equal(inventory.reserve(request).everApplied, false);
    assert.equal(inventory.stock('tenant', 'wh', 'A'), 10);
  } finally { inventory.close(); }
});

test('different intents cannot overdraw the same resource', () => {
  const inventory = new Inventory(createRunDirectory());
  try {
    inventory.seed('tenant', 'wh', 'A', 10);
    assert.equal(inventory.reserve({ ...request, quantity: 6, argsHash: 'hash-6' }).state, 'RESERVED');
    assert.equal(inventory.reserve({ ...request, intentKey: 'other-order', quantity: 6, argsHash: 'hash-6' }).state, 'REJECTED');
    assert.equal(inventory.stock('tenant', 'wh', 'A'), 4);
  } finally { inventory.close(); }
});
