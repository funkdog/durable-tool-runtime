import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('live entries require dedicated credentials and opt-in before reading a budget file',()=>{
  for(const [script,args] of [['agent-acceptance.ts',['normal','missing-budget.json']],['cold-start.ts',['after_commit','--live','missing-budget.json']]] as const){
    const result=spawnSync(process.execPath,[fileURLToPath(new URL(`../scripts/${script}`,import.meta.url)),...args],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:5000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/POC_ALLOW_LIVE=1/);assert.doesNotMatch(result.stderr,/ENOENT/);
  }
});
