import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTask } from '../src/agent-input.ts';
import { judgeAgent, type AgentEvidence } from '../src/agent-verdict.ts';
const run: AgentEvidence = { mode: 'live', sessionId: 'session', exitCode: 0, stopReason: null, messages: [] };
test('mock model never passes real-agent acceptance', () => {
  assert.equal(judgeAgent({ ...run, mode: 'mock' }, []).agent, 'NOT_RUN');
});
test('zero real tool calls cannot count as a successful execution', () => {
  assert.equal(judgeAgent(run, []).agent, 'FAIL');
});
test('task input contains business intent and recovery refs, not oracle or secrets', () => {
  const task = { taskId: 't', goal: 'reserve' as const, input: { intentRef: 'i', warehouseId: 'w', sku: 's', quantity: 3 }, recovery: null };
  assert.match(renderTask(task), /"intentRef": "i"/);
  assert.doesNotMatch(renderTask(task), /bearer|after_commit|effectCount/);
  assert.throws(() => renderTask({ ...task, token: 'secret' } as typeof task));
});
test('gateway success with only an accepted runtime response cannot support an Agent success claim', () => {
  const observed = { operationId: 'o', intentRef: 'i', executionState: 'APPLIED', observation: { state: 'RESERVED', receiptId: 'r' } };
  const calls = [{ id: 'c', grant_id: 'g', run_id: 'run', tool: 'operation_get', args_json: '{}', started_at: 1, completed_at: 2, result_json: JSON.stringify({ structuredContent: observed }) }];
  const agent = { ...run, messages: [{ at: 4, text: JSON.stringify({ status: 'reserved', operationId: 'o', intentRef: 'i', receiptId: 'r' }) }],
    toolEvents: [{ at: 3, item: { status: 'completed', result: { structuredContent: { ...observed, executionState: 'ACCEPTED', observation: null } } } }] };
  assert.equal(judgeAgent(agent, calls).agent, 'FAIL');
});
test('matching runtime and gateway receipt before final claim supports the structured verdict', () => {
  const data = { operationId: 'o', intentRef: 'i', executionState: 'APPLIED', observation: { state: 'RESERVED', receiptId: 'r' } };
  const calls = [{ id:'c',grant_id:'g',run_id:'run',tool:'operation_get',args_json:'{}',started_at:1,completed_at:2,result_json:JSON.stringify({structuredContent:data}) }];
  const agent = { ...run,messages:[{at:4,text:JSON.stringify({status:'reserved',operationId:'o',intentRef:'i',receiptId:'r'})}],
    toolEvents:[{at:3,item:{status:'completed',tool:'operation_get',arguments:{},result:{structured_content:data}}}] };
  assert.equal(judgeAgent(agent,calls).agent,'PASS');
  assert.equal(judgeAgent({...agent,messages:[{...agent.messages[0],at:1}]},calls).agent,'FAIL');
  assert.equal(judgeAgent(agent,[{...calls[0],args_json:'{"operationId":"different"}'}]).agent,'FAIL');
});
