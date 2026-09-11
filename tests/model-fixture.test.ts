import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFixture } from '../src/model-fixture.ts';

const input = { intentRef: 'fixture-intent', warehouseId: 'demo', sku: 'SKU-001', quantity: 3 };
async function response(tools: unknown[], output?: unknown) {
  const fixture = await modelFixture(input, 'fixture-only-token');
  try {
    const send = (items: unknown[]) => fetch(fixture.url + '/responses', { method: 'POST',
      headers: { authorization: 'Bearer fixture-only-token', 'content-type': 'application/json' },
      body: JSON.stringify({ tools, input: items }) });
    if (output !== undefined) await (await send([])).text();
    const res = await send(output === undefined ? [] : [{ type: 'function_call_output', call_id: 'fixture-call', output }]);
    assert.equal(res.status, 200);
    const events = (await res.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    return events.find(e => e.type === 'response.completed').response.output[0];
  } finally {
    fixture.server.closeAllConnections();
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
}

test('simulated Responses retain the advertised namespace for direct tool calls', async () => {
  const item = await response([{ type: 'namespace', name: 'mcp__governance', tools: [
    { type: 'function', name: 'inventory_reservation_submit', parameters: {} },
  ] }]);
  assert.equal(item.type, 'function_call');
  assert.equal(item.name, 'inventory_reservation_submit');
  assert.equal(item.namespace, 'mcp__governance');
  assert.deepEqual(JSON.parse(item.arguments), input);
});

test('simulated completion reads observed native output envelopes without treating errors as success', async () => {
  const tools = [{ type: 'function', name: 'mcp__governance__inventory_reservation_submit' },
    { type: 'function', name: 'mcp__governance__operation_get' }];
  const applied = { operationId: 'fixture-op', executionState: 'APPLIED', observation: { state: 'RESERVED', receiptId: 'fixture-receipt' } };
  for (const output of [JSON.stringify(applied), `Wall time: 0.0089 seconds\nOutput:\n${JSON.stringify(applied)}`,
    { content: [{ type: 'text', text: JSON.stringify(applied) }] }]) {
    const item = await response(tools, output);
    assert.equal(item.type, 'message');
    assert.equal(JSON.parse(item.content[0].text).receiptId, 'fixture-receipt');
  }
  const pending = await response(tools, 'Wall time: 0.0089 seconds\nOutput:\n{"operationId":"fixture-op","executionState":"UNKNOWN"}');
  assert.equal(pending.name, 'mcp__governance__operation_get');
  const error = await response(tools, 'unsupported call: inventory_reservation_submit');
  assert.equal(error.type, 'function_call');
});

test('simulated Responses also support flat function and code-mode discovery', async () => {
  const flat = await response([{ type: 'function', name: 'mcp__governance__inventory_reservation_submit' }]);
  assert.equal(flat.name, 'mcp__governance__inventory_reservation_submit');
  assert.equal(flat.namespace, undefined);
  const code = await response([{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }]);
  assert.equal(code.type, 'custom_tool_call');
  assert.equal(code.namespace, 'functions');
  assert.match(code.input, /ALL_TOOLS/);
});
