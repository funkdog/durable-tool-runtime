import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness, until } from '../src/harness.ts';
import { CallAudit } from '../src/call-audit.ts';
import { CodexRun } from '../src/codex-launcher.ts';
import { modelFixture } from '../src/model-fixture.ts';
import { judgeAgent } from '../src/agent-verdict.ts';

const h = new Harness(); let run: CodexRun | undefined; let resumed: CodexRun | undefined; let interrupted: CodexRun | undefined; let model: Awaited<ReturnType<typeof modelFixture>> | undefined;
let resumeModel: Awaited<ReturnType<typeof modelFixture>> | undefined;
try {
  await h.start(); const f = h.setup({ intentRef: 'transport-1', warehouseId: 'w', sku: 's', quantity: 3 });
  await h.process('worker'); const token = randomBytes(32).toString('base64url');
  model = await modelFixture(f.input, token);
  run = new CodexRun({ directory: h.dir, codexBinary: process.env.POC_CODEX_BIN ?? 'codex', mode: 'mock', model: process.env.POC_MODEL ?? 'fixture-model',
    modelProxyUrl: model.url + '/v1', modelProxyToken: token, mcpUrl: h.gatewayUrls[0] + '/mcp', grantToken: f.token,
    task: { taskId: f.task.id, goal: 'reserve', input: f.input, recovery: null }, timeoutMs: 30_000 });
  const agent = await run.done; const calls = new CallAudit(h.store).list(h.core.authenticate(f.token).run_id);
  const verdict = judgeAgent(agent, calls);
  const root = fileURLToPath(new URL('..',import.meta.url));
  const report = { kind: 'NATIVE_CODEX_MOCK_MODEL_TRANSPORT',
    sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    dirtyWorktree:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),
    agent, calls, verdict, diagnostics: model.diagnostics(), inventory: h.inventory.snapshot(), directory: run.directory };
  writeFileSync(join(h.dir, 'agent-transport.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ exit: agent.exitCode, stop: agent.stopReason, session: agent.sessionId, calls: calls.length, verdict,
    diagnostics: { requests:model.diagnostics().requests, tools:model.diagnostics().toolNames }, report: join(h.dir, 'agent-transport.json'), runtimeDirectory: run.directory }, null, 2));
  assert.equal(agent.exitCode, 0); assert.ok(agent.sessionId); assert.ok(calls.length >= 2); assert.ok(agent.toolEvents!.length >= 2);
  assert.equal(h.inventory.stock(f.task.tenant_id, 'w', 's'), 7); assert.equal(verdict.agent, 'NOT_RUN');
  const renewedToken = h.controller.grant(f.task.id, [f.input.intentRef]);
  resumeModel = await modelFixture(f.input, token, 'reserved', 'get');
  resumed = new CodexRun({ directory: h.dir, codexBinary: process.env.POC_CODEX_BIN ?? 'codex', mode: 'mock', model: process.env.POC_MODEL ?? 'fixture-model',
    modelProxyUrl: resumeModel.url + '/v1', modelProxyToken: token, mcpUrl: h.gatewayUrls[1] + '/mcp', grantToken: renewedToken,
    task: {taskId:f.task.id,goal:'reserve',input:f.input,recovery:{priorRunId:h.core.authenticate(f.token).run_id,operationId:null,reason:'Resume existing session'}},
    resume:{runtimeDirectory:run.runtimeDirectory,sessionId:agent.sessionId!},timeoutMs:30_000 });
  const resumedEvidence = await resumed.done;
  const resumedCalls = new CallAudit(h.store).list(h.core.authenticate(renewedToken).run_id);
  writeFileSync(join(h.dir,'agent-resume-transport.json'),JSON.stringify({agent:resumedEvidence,calls:resumedCalls,diagnostics:resumeModel.diagnostics()},null,2),{mode:0o600});
  assert.equal(resumedEvidence.exitCode,0); assert.equal(resumedEvidence.sessionId,agent.sessionId); assert.ok(resumedCalls.length>=1);
  assert.equal(h.inventory.stock(f.task.tenant_id,'w','s'),7);
  console.log(JSON.stringify({resume:'TRANSPORT_PASS',sameSession:true,newGrantCalls:resumedCalls.length,realAgent:'NOT_RUN'},null,2));
  const audit = new CallAudit(h.store); audit.arm('inventory_reservation_submit','hold');
  const interruptToken = h.controller.grant(f.task.id,[f.input.intentRef]);
  interrupted = new CodexRun({directory:h.dir,codexBinary:process.env.POC_CODEX_BIN ?? 'codex',mode:'mock',model:process.env.POC_MODEL ?? 'fixture-model',
    modelProxyUrl:model.url+'/v1',modelProxyToken:token,mcpUrl:h.gatewayUrls[0]+'/mcp',grantToken:interruptToken,
    task:{taskId:f.task.id,goal:'reserve',input:f.input,recovery:null},timeoutMs:30_000});
  await until(()=>audit.fault('inventory_reservation_submit')?.hits===1,Boolean,20000);
  interrupted.stop(); await interrupted.done; audit.release('inventory_reservation_submit');
  assert.equal(interrupted.evidence.stopReason,'INJECTED_INTERRUPTION');
  await until(()=>{try{process.kill(-interrupted!.child.pid!,0);return false;}catch{return true;}},Boolean,3000);
  console.log(JSON.stringify({interrupt:'TRANSPORT_PASS',ownProcessGroupStopped:true,realAgent:'NOT_RUN'},null,2));
} finally {
  await interrupted?.close();
  await resumed?.close(); if(resumeModel){resumeModel.server.closeAllConnections();await new Promise<void>(resolve=>resumeModel!.server.close(()=>resolve()));}
  await run?.close(); if (model) { model.server.closeAllConnections(); await new Promise<void>(resolve => model!.server.close(() => resolve())); }
  await h.close();
}
