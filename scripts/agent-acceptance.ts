import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness, until } from '../src/harness.ts';
import { CallAudit } from '../src/call-audit.ts';
import { CodexRun } from '../src/codex-launcher.ts';
import { BudgetLedger, modelProxy } from '../src/model-budget.ts';
import { judgeAgent } from '../src/agent-verdict.ts';
import { businessRequest } from '../src/worker.ts';

const [scenario, policyPath] = process.argv.slice(2);
const cases = ['normal','agent_restart','session_resume','worker_restart','combined_restart','lost_response','authorization','stale_epoch','cancel','unknown','consumed'];
if (!cases.includes(scenario) || !policyPath) throw new Error('Usage: npm run agent:acceptance -- <case> <budget.json>; see docs/real-agent.md');
if (process.env.POC_ALLOW_LIVE !== '1' || !process.env.POC_OPENAI_API_KEY) throw new Error('Live execution requires POC_ALLOW_LIVE=1 and dedicated POC_OPENAI_API_KEY; no existing login tokens are read');
const budget = new BudgetLedger(JSON.parse(readFileSync(policyPath, 'utf8')));
const pricingDate = Date.parse(budget.policy.pricingCheckedAt);
if (Date.now() - pricingDate > 7 * 86_400_000 || pricingDate > Date.now() + 60_000) throw new Error('Verify current model pricing before running this budget policy');
if (!['developers.openai.com','platform.openai.com','learn.chatgpt.com'].includes(new URL(budget.policy.pricingSource).hostname)) throw new Error('Pricing source must be official');
const h = new Harness(); const audit = new CallAudit(h.store); const runs: CodexRun[] = [];
const proxyToken = randomBytes(32).toString('base64url');
let proxy: Awaited<ReturnType<typeof modelProxy>> | undefined;
let caseValid = false; let failure: string | null = null; let agentVerdict: object = { agent: 'NOT_RUN' }; let platformVerdict = 'NOT_OBSERVED';
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  await h.start(scenario === 'unknown' ? 'weak' : 'full');
  const f = h.setup({ intentRef: 'order-42-line-1-v1', warehouseId: 'demo-warehouse', sku: 'CAT-001', quantity: 3 });
  let input = f.input; let token = f.token;
  if (scenario === 'authorization') { input = { ...input, intentRef: 'order-43-line-1-v1' }; h.controller.addIntent(f.task, input); }
  if (scenario === 'stale_epoch') h.controller.takeover(f.task.id, 1);
  proxy = await modelProxy(process.env.POC_OPENAI_API_KEY!, proxyToken, budget);
  const launch = (goal: 'reserve' | 'cancel', recovery: { priorRunId: string; operationId: string | null; reason: string } | null = null, resume?: CodexRun) => {
    const run = new CodexRun({ directory: h.dir, codexBinary: process.env.POC_CODEX_BIN ?? 'codex', mode: 'live',
      model: budget.policy.model, modelProxyUrl: proxy!.url + '/v1', modelProxyToken: proxyToken, mcpUrl: h.gatewayUrls[0] + '/mcp', grantToken: token,
      task: { taskId: f.task.id, input, goal, recovery }, timeoutMs: 180_000,
      resume: resume ? { runtimeDirectory: resume.runtimeDirectory, sessionId: resume.evidence.sessionId! } : undefined });
    runs.push(run); return run;
  };
  const faultCase = ['worker_restart','combined_restart','unknown'].includes(scenario);
  if (faultCase) h.inventory.armFault('after_commit_before_response', h.core.catalog.implementation.intentKey(f.task.tenant_id, input.intentRef), scenario === 'unknown' ? 'drop' : 'hold');
  if (scenario === 'lost_response') audit.arm('inventory_reservation_submit', 'drop');
  if (['agent_restart','session_resume'].includes(scenario)) audit.arm('inventory_reservation_submit', 'hold');
  const firstWorker = await h.process('worker'); let active = launch('reserve');
  if (['worker_restart','combined_restart'].includes(scenario)) {
    await until(() => h.inventory.fault('after_commit_before_response')?.hits === 1, Boolean, 150_000); caseValid = true;
    await h.kill(firstWorker, 'SIGKILL');
    if (scenario === 'combined_restart') { active.stop(); await active.done; }
    await h.process('worker'); h.inventory.releaseFault('after_commit_before_response');
  }
  if (['agent_restart','session_resume'].includes(scenario)) {
    await until(() => audit.fault('inventory_reservation_submit')?.hits === 1, Boolean, 150_000); caseValid = true;
    active.stop(); await active.done; audit.release('inventory_reservation_submit');
  }
  if (['agent_restart','session_resume','combined_restart'].includes(scenario)) {
    const previous = active; const priorRunId = h.core.authenticate(token).run_id;
    h.controller.takeover(f.task.id, 1); token = h.controller.grant(f.task.id, [input.intentRef]);
    active = launch('reserve', { priorRunId, operationId: null, reason: 'Previous agent process interrupted; result must be established' }, scenario === 'session_resume' ? previous : undefined);
  }
  const firstResult = await active.done;
  if (['cancel','consumed'].includes(scenario)) {
    const prior = judgeAgent(firstResult, audit.list(h.core.authenticate(token).run_id), 'reserved');
    assert.equal(prior.agent, 'PASS', 'Initial reservation must genuinely complete before cancellation stage');
    const op = h.store.snapshot().operations.find(o => o.kind === 'reserve')!;
    if (scenario === 'consumed') h.inventory.consume(businessRequest(h.store.get(String(op.id))!));
    const previous = active; const priorRunId = h.core.authenticate(token).run_id;
    token = h.controller.grant(f.task.id, [input.intentRef], ['read','cancel']);
    active = launch('cancel', { priorRunId, operationId: String(op.id), reason: 'User changed the business goal to cancellation' }, previous);
    await active.done; caseValid = true;
  }
  if (scenario === 'lost_response') caseValid = audit.fault('inventory_reservation_submit')?.hits === 1;
  else if (scenario === 'unknown') caseValid = h.inventory.fault('after_commit_before_response')?.hits === 1;
  else if (['normal','authorization','stale_epoch'].includes(scenario)) caseValid = true;
  const expected = scenario === 'unknown' ? 'unknown' : ['authorization','stale_epoch'].includes(scenario) ? 'denied'
    : scenario === 'cancel' ? 'cancelled' : scenario === 'consumed' ? 'not_applied' : 'reserved';
  agentVerdict = judgeAgent(active.evidence, audit.list(h.core.authenticate(token).run_id), expected);
  await h.stopProcesses();
  platformVerdict = 'FAIL';
  const inventory = h.inventory.snapshot();
  for (const stock of inventory.stock) {
    const outstanding = inventory.reservations.filter(r => ['RESERVED','CONSUMED'].includes(String(r.state))).reduce((sum,r) => sum + Number(r.quantity), 0);
    assert.equal(Number(stock.available) + outstanding, Number(stock.initial)); assert.ok(Number(stock.available) >= 0);
  }
  assert.ok(inventory.effects.filter(e => e.kind === 'reserve').length <= 1);
  assert.ok(inventory.effects.filter(e => e.kind === 'release').length <= 1);
  if (['authorization','stale_epoch'].includes(scenario)) assert.equal(h.store.snapshot().operations.length, 0);
  platformVerdict = 'PASS';
  assert.equal(caseValid, true, 'Fault must actually be observed, not inferred from a delay');
  assert.equal((agentVerdict as any).agent, 'PASS', 'Agent claim must be supported before it was made');
} catch (error) { failure = (error as Error).message; process.exitCode = 1; }
finally {
  await Promise.all(runs.map(r => r.close()));
  const finalState = await h.finalSnapshot();
  const report = { scenario, failure, caseValid, agentVerdict, platformVerdict, mode: 'live',
    sourceCommit: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    dirtyWorktree: Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),
    runs: runs.map(r => ({ directory:r.directory, pid:r.child.pid, evidence:r.evidence })), budget:budget.snapshot(), calls:audit.list(),
    ...finalState,
    claimCeiling:'Scenario-level real-model evidence; no universal recovery or billing-hard-cap guarantee. Independent review required.' };
  writeFileSync(join(h.dir,'real-agent-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  if(proxy){proxy.server.closeAllConnections();await new Promise<void>(resolve=>proxy!.server.close(()=>resolve()));}
  await h.close(); console.log(JSON.stringify({scenario,failure,caseValid,agentVerdict,report:join(h.dir,'real-agent-report.json')},null,2));
}
