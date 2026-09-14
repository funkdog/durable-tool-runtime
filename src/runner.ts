import { Store } from './store.ts';
import { RunStore, type RuntimeBinding } from './run-store.ts';
import { Controller } from './controller.ts';
import { CodexRun } from './codex-launcher.ts';
import { CallAudit } from './call-audit.ts';
import { verifyAgentEvidence, type AgentEvidence } from './agent-verdict.ts';
import { processIdentity } from './process-identity.ts';
import { testBarrier } from './scheduler.ts';

export async function runnerMain(directory:string,id:string,owner:string):Promise<void> {
  const store=new Store(directory);const runs=new RunStore(store);const identity=processIdentity(process.pid);
  if(!identity||!runs.claimRunner(id,owner,process.pid,identity)){store.close();return;}
  const record=runs.run(id)!;let active:CodexRun|undefined;
  const heartbeat=setInterval(()=>{try{if(!runs.heartbeat(id,owner))active?.stop('RUN_SUPERSEDED');}catch{active?.stop('HEARTBEAT_FAILED');}},500);
  const stop=()=>active?.stop('RUNNER_STOPPED');process.on('SIGTERM',stop);process.on('SIGINT',stop);
  try{
    await testBarrier(directory,'runner','after_claim',{runId:id});
    const task=runs.tasks().find(t=>t.task_id===record.task_id)!;const binding=JSON.parse(task.binding_json) as RuntimeBinding;
    if(!process.env.POC_MODEL_PROXY_TOKEN)throw new Error('MODEL_BINDING_UNAVAILABLE');
    const token=new Controller(store).grant(record.task_id,JSON.parse(record.intents_json),JSON.parse(record.scopes_json),binding.timeoutMs+30_000,id);
    active=new CodexRun({...binding,directory,modelProxyToken:process.env.POC_MODEL_PROXY_TOKEN,grantToken:token,
      task:runs.input(id),instanceId:id,inheritProcessGroup:true});
    await testBarrier(directory,'runner','after_agent_spawn',{runId:id,agentPid:active.child.pid});
    const evidence=await active.done;
    let status:string|undefined;try{status=JSON.parse(evidence.messages.at(-1)?.text??'').status;}catch{}
    const expected=record.goal==='reserve'?'reserved':'cancelled';
    const checked=verifyAgentEvidence(evidence,new CallAudit(store).list(id),status&&['unknown','denied','not_applied'].includes(status)?status:expected);
    const verdict={state:checked.agent==='INCOMPLETE'?'INCOMPLETE':checked.agent==='PASS'&&status===expected?'PASS':'BLOCKED',
      agent:binding.mode==='live'?checked.agent:'NOT_RUN',protocol:checked.agent,reason:checked.reason,status,mode:binding.mode};
    runs.finish(id,owner,evidence,verdict);
    await testBarrier(directory,'runner','after_finish',{runId:id});
  }catch(error){
    const evidence:AgentEvidence=active?.evidence??{mode:'mock',sessionId:null,exitCode:null,stopReason:'RUNNER_ERROR',messages:[],toolEvents:[]};
    runs.finish(id,owner,evidence,{state:'INCOMPLETE',agent:'INCOMPLETE',reason:(error as Error).message});
  }finally{
    clearInterval(heartbeat);store.close();
    // This process is the freshly detached group leader; includes wrapper + native Agent.
    process.kill(-process.pid,'SIGKILL');
  }
}
