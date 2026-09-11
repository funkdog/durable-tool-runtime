import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coldScenarios, runColdScenario } from '../../src/cold-scenario.ts';
for(const scenario of coldScenarios)test(`scheduler SIGKILL at ${scenario}; simulated model`,{timeout:120_000},async(t)=>{
  const result=await runColdScenario(scenario,undefined,t.signal);assert.equal(result.failure,null,`${result.failure}; report: ${result.report}`);
});
