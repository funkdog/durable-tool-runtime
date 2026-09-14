import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness, until } from './harness.ts';
import { RunStore, PersistentRequestBudget } from './run-store.ts';
import { CallAudit } from './call-audit.ts';
import { modelFixture } from './model-fixture.ts';
import { BudgetLedger, modelProxy, type ModelBudget } from './model-budget.ts';
import { stopOwnedRunner } from './process-identity.ts';

export const coldScenarios=['before_launch','after_spawn','after_commit','before_consume'] as const;
export type ColdScenario=typeof coldScenarios[number];
export async function runColdScenario(scenario:ColdScenario,policy?:ModelBudget,signal?:AbortSignal){
  if(!coldScenarios.includes(scenario))throw new Error('Unsupported cold-start scenario');
  if(policy&&(process.env.POC_ALLOW_LIVE!=='1'||!process.env.POC_OPENAI_API_KEY))throw new Error('Live mode requires explicit opt-in and dedicated API key');
  const ledger=policy?new BudgetLedger(policy):undefined;const mode=policy?'live':'mock';
  const h=new Harness();const runs=new RunStore(h.store);const audit=new CallAudit(h.store);const children:ReturnType<typeof spawn>[]=[];
  let model:Awaited<ReturnType<typeof modelFixture>>|undefined;let proxy:Awaited<ReturnType<typeof modelProxy>>|undefined;
  let failure:string|null=null;const witnesses:unknown[]=[];let firstRunId='';
  const root=fileURLToPath(new URL('..',import.meta.url));
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const dirtyWorktree=Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim());
  const credential=randomBytes(32).toString('base64url');const counter=new PersistentRequestBudget(h.store,'cold-episode',policy?.maxRequests??12);
  const ensureActive=()=>{if(signal?.aborted)throw new Error('EXPERIMENT_ABORTED');};
  const ensureTaskActive=()=>{
    ensureActive();const task=runs.tasks()[0];
    if(task?.state==='BLOCKED')throw new Error(`SCHEDULE_BLOCKED: ${task.blocked_reason??runs.run(task.current_run_id)?.verdict_json??'No verdict'}`);
  };
  const start=(barrier?:string,runnerBarrier?:string)=>{
    ensureActive();const child=spawn(process.execPath,[fileURLToPath(new URL('./process.ts',import.meta.url)),'scheduler',h.dir],{
      stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',POC_MODEL_PROXY_TOKEN:credential,
        POC_SCHEDULER_TEST_BARRIER:barrier,POC_RUNNER_TEST_BARRIER:runnerBarrier}});
    children.push(child);let stderr='';child.stderr!.on('data',x=>stderr+=x);child.stdout!.resume();child.on('error',e=>stderr+=e.message);
    return {child,errors:()=>stderr};
  };
  const stop=async(child:ReturnType<typeof spawn>)=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await until(()=>child.exitCode!==null||child.signalCode!==null);};
  const witness=async(role:string,phase:string,pid?:number)=>{
    const file=await until(()=>{ensureTaskActive();return readdirSync(h.dir).find(f=>f.startsWith(`${role}-${phase}-`)&&(!pid||f===`${role}-${phase}-${pid}.json`));},Boolean,150_000);
    const item=JSON.parse(readFileSync(join(h.dir,file!),'utf8'));witnesses.push(item);return item;
  };
  try{
    ensureActive();await h.start();const f=h.setup({intentRef:'cold-order-42-line-1-v1',warehouseId:'demo-warehouse',sku:'SKU-001',quantity:3});
    if(policy)proxy=await modelProxy(process.env.POC_OPENAI_API_KEY!,credential,ledger!,counter);
    else model=await modelFixture(f.input,credential);
    firstRunId=runs.enqueue(f.token,'reserve',{mode,model:policy?.model??process.env.POC_MODEL??'fixture-model',modelProxyUrl:(proxy??model)!.url+'/v1',
      mcpUrl:h.gatewayUrls[0]+'/mcp',codexBinary:process.env.POC_CODEX_BIN??'codex',timeoutMs:policy?180_000:30_000},1);
    const worker=await h.process('worker');
    if(scenario==='after_commit')h.inventory.armFault('after_commit_before_response',h.core.catalog.implementation.intentKey(f.task.tenant_id,f.input.intentRef),'hold');
    const first=start(scenario==='after_commit'?undefined:scenario,scenario==='after_spawn'?'after_agent_spawn':undefined);
    if(scenario==='after_commit'){
      await until(()=>{ensureTaskActive();if(first.child.exitCode!==null)throw new Error(first.errors());return h.inventory.fault('after_commit_before_response')?.hits===1;},Boolean,150_000);
      witnesses.push({phase:'after_commit',at:Date.now(),operations:h.store.snapshot().operations,inventory:h.inventory.snapshot()});
      await stop(first.child);stopOwnedRunner(runs.run(firstRunId)!,h.dir);await h.kill(worker,'SIGKILL');await h.process('worker');h.inventory.releaseFault('after_commit_before_response');
    }else{
      await witness('scheduler',scenario,first.child.pid);if(scenario==='after_spawn')await witness('runner','after_agent_spawn');
      await stop(first.child);if(scenario==='after_spawn')writeFileSync(join(h.dir,'release-runner-after_agent_spawn'),'release',{mode:0o600});
    }
    // Replacement receives only the persistent data root and trusted service credential, never priorRunId/old grant.
    const replacement=start();const competitor=scenario==='before_launch'?start():undefined;
    await until(()=>{ensureActive();if(replacement.child.exitCode!==null)throw new Error(replacement.errors());
      if(competitor&&competitor.child.exitCode!==null)throw new Error(competitor.errors());return runs.tasks()[0].state!=='ACTIVE';},Boolean,policy?380_000:80_000);
    const task=runs.tasks()[0];const last=runs.run(task.current_run_id)!;assert.equal(task.state,'COMPLETED',last.verdict_json??task.blocked_reason??'No verdict');
    assert.equal(h.inventory.stock(f.task.tenant_id,f.input.warehouseId,f.input.sku),7);assert.equal(h.inventory.snapshot().effects.filter(e=>e.kind==='reserve').length,1);
    assert.equal(h.store.db.prepare('SELECT id FROM runs WHERE managed=1').all().length,scenario==='after_commit'?2:1);
    if(scenario==='after_commit')assert.equal(last.previous_run_id,firstRunId);
    const verdict=JSON.parse(last.verdict_json!);assert.equal(verdict.agent,policy?'PASS':'NOT_RUN');assert.equal(verdict.protocol,'PASS');
  }catch(error){failure=(error as Error).message;}
  finally{
    for(const child of children)await stop(child);
    for(const row of h.store.db.prepare('SELECT id FROM runs WHERE managed=1').all())stopOwnedRunner(runs.run(String(row.id))!,h.dir);
    const endpoint=proxy??model;if(endpoint){endpoint.server.closeAllConnections();await new Promise<void>(r=>endpoint.server.close(()=>r()));}
    const finalState=await h.finalSnapshot();
    const report={scenario,mode,failure,sourceCommit,dirtyWorktree,witnesses,firstRunId,schedulers:children.map(c=>({pid:c.pid,exitCode:c.exitCode,signal:c.signalCode})),
      tasks:runs.tasks(),runs:h.store.db.prepare('SELECT * FROM runs WHERE managed=1 ORDER BY created_at').all(),events:h.store.db.prepare('SELECT * FROM schedule_events ORDER BY seq').all(),
      calls:audit.list(),...finalState,fixture:model?.diagnostics(),budget:ledger?.snapshot(),persistedRequests:counter.used};
    await h.close();const remaining=()=>execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').filter(l=>l.includes(h.dir)&&/process\.ts|\/workspace/.test(l));
    try{await until(()=>remaining().length===0,Boolean,5000);}catch{failure=failure??'OWNED_PROCESSES_REMAIN';}
    writeFileSync(join(h.dir,'cold-start-report.json'),JSON.stringify({...report,failure,cleanup:{remaining:remaining()}},null,2),{mode:0o600});
  }
  return {scenario,mode,failure,report:join(h.dir,'cold-start-report.json')};
}
