import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetLedger, modelProxy } from '../src/model-budget.ts';
const policy = { model: 'test', maxRequests: 1, maxInputBytes: 1000, maxOutputTokens: 128, maxEstimatedUsd: 1,
  inputUsdPerMillion: 1, outputUsdPerMillion: 1, pricingSource: 'https://developers.openai.com/api/docs/pricing', pricingCheckedAt: '2026-09-11T00:00:00Z' };
test('request reservation is bounded and missing usage never refunds budget', () => {
  const ledger = new BudgetLedger(policy); ledger.admit({ input: 'hello' });
  assert.ok(ledger.reservedUsd > 0); assert.throws(() => ledger.admit({ input: 'hello' }), /BUDGET_EXHAUSTED/);
});
test('public API adapter refuses forwarding when the persistent counter denies admission',async()=>{
  const originalFetch=globalThis.fetch;let forwarded=0;
  globalThis.fetch=(async()=>{forwarded++;throw new Error('Must not forward');}) as typeof fetch;
  const proxy=await modelProxy('fixture-api-key','fixture-relay-key',new BudgetLedger(policy),{reserve:()=>false});
  try{
    const response=await originalFetch(proxy.url+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-relay-key','content-type':'application/json'},body:'{"input":[]}'});
    assert.equal(response.status,429);assert.equal(forwarded,0);
  }finally{globalThis.fetch=originalFetch;proxy.server.closeAllConnections();await new Promise<void>(resolve=>proxy.server.close(()=>resolve()));}
});
test('oversized input and absent explicit budget are rejected before model request', () => {
  const ledger = new BudgetLedger(policy); assert.throws(() => ledger.admit('x'.repeat(1001)), /BUDGET_EXHAUSTED/);
  assert.equal(ledger.requests, 0); assert.throws(() => new BudgetLedger({} as typeof policy));
  assert.throws(() => new BudgetLedger({ ...policy, maxEstimatedUsd: 0 }));
});
