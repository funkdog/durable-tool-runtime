import { randomUUID } from 'node:crypto';
import { now, transaction } from './db.ts';
import { Core } from './core.ts';
import type { Store } from './store.ts';
import type { AgentTask } from './agent-input.ts';
import type { AgentEvidence } from './agent-verdict.ts';
import { loopbackUrl } from './http.ts';

export interface RuntimeBinding { mode:'live'|'mock'; model:string; modelProxyUrl:string; mcpUrl:string; codexBinary:string; timeoutMs:number }
export interface RunRecord {
  id:string;tenant_id:string;task_id:string;previous_run_id:string|null;task_epoch:number;managed:number;state:string;
  intents_json:string;scopes_json:string;goal:'reserve'|'cancel';input_json:string;runner_owner:string|null;
  runner_pid:number|null;runner_identity:string|null;heartbeat_until:number|null;launches:number;
  evidence_json:string|null;verdict_json:string|null;
}
export interface ScheduledTask { task_id:string;current_run_id:string;state:string;binding_json:string;recovery_count:number;max_recoveries:number;deadline:number;blocked_reason:string|null }
export class RunStore {
  readonly store:Store;
  constructor(store:Store) {this.store=store;}
  run(id:string) { return this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as RunRecord|undefined; }
  tasks() { return this.store.db.prepare('SELECT * FROM scheduled_tasks ORDER BY task_id').all() as unknown as ScheduledTask[]; }
  event(task:string,run:string,type:string,detail:unknown=null) {
    this.store.db.prepare('INSERT INTO schedule_events(task_id,run_id,type,detail_json,created_at) VALUES(?,?,?,?,?)').run(task,run,type,JSON.stringify(detail),now(this.store.db));
  }
  enqueue(token:string,goal:'reserve'|'cancel',binding:RuntimeBinding,maxRecoveries=2):string {
    loopbackUrl(binding.mcpUrl); loopbackUrl(binding.modelProxyUrl);
    if (!['live','mock'].includes(binding.mode) || !['reserve','cancel'].includes(goal) || !Number.isInteger(maxRecoveries) || maxRecoveries<0 || maxRecoveries>3
      || binding.timeoutMs<1000 || binding.timeoutMs>180_000) throw new Error('INVALID_SCHEDULE');
    return transaction(this.store.db,()=>{
      const grant=new Core(this.store).authenticate(token,goal,true);
      const refs=JSON.parse(grant.allowed_intent_refs_json) as string[];
      if(refs.length!==1)throw new Error('POC_REQUIRES_ONE_INTENT');
      const intent=this.store.db.prepare('SELECT input_json FROM intents WHERE tenant_id=? AND task_id=? AND ref=?').get(grant.tenant_id,grant.task_id,refs[0]);
      if(!intent)throw new Error('INTENT_NOT_FOUND');
      if(this.store.db.prepare('SELECT 1 FROM scheduled_tasks WHERE task_id=?').get(grant.task_id))throw new Error('ALREADY_SCHEDULED');
      // Enrolment retires fixture authority; only the managed Run may issue new commands.
      this.store.db.prepare('UPDATE tasks SET epoch=epoch+1 WHERE id=?').run(grant.task_id);
      const id=this.insert(grant.tenant_id,grant.task_id,grant.task_epoch+1,null,goal,String(intent.input_json),grant.allowed_intent_refs_json,grant.scopes_json);
      this.store.db.prepare(`INSERT INTO scheduled_tasks(task_id,current_run_id,state,binding_json,max_recoveries,deadline,updated_at)
        VALUES(?,?,'ACTIVE',?,?,?,?)`).run(grant.task_id,id,JSON.stringify(binding),maxRecoveries,now(this.store.db)+(maxRecoveries+1)*(binding.timeoutMs+30_000),now(this.store.db));
      this.event(grant.task_id,id,'TaskScheduled');return id;
    });
  }
  private insert(tenant:string,task:string,epoch:number,prior:string|null,goal:string,input:string,intents:string,scopes:string):string {
    const id=randomUUID();
    this.store.db.prepare(`INSERT INTO runs(id,tenant_id,task_id,previous_run_id,task_epoch,managed,state,intents_json,scopes_json,goal,input_json,created_at)
      VALUES(?,?,?,?,?,1,'READY',?,?,?,?,?)`).run(id,tenant,task,prior,epoch,intents,scopes,goal,input,now(this.store.db));return id;
  }
  reserveLaunch(id:string):boolean {
    return transaction(this.store.db,()=>{
      const at=now(this.store.db);
      const result=this.store.db.prepare(`UPDATE runs SET launches=launches+1,next_launch_at=? WHERE id=? AND state='READY' AND launches<5 AND next_launch_at<=?
        AND EXISTS(SELECT 1 FROM scheduled_tasks WHERE current_run_id=runs.id AND state='ACTIVE')`).run(at+1000,id,at);
      if(Number(result.changes)){const run=this.run(id)!;this.event(run.task_id,id,'LaunchRequested',{attempt:run.launches});return true;}return false;
    });
  }
  claimRunner(id:string,owner:string,pid:number,identity:string):boolean {
    return transaction(this.store.db,()=>{
      const run=this.run(id);if(!run)return false;
      const changed=this.store.db.prepare(`UPDATE runs SET state='RUNNING',runner_owner=?,runner_pid=?,runner_identity=?,heartbeat_until=?
        WHERE id=? AND state='READY' AND EXISTS(SELECT 1 FROM scheduled_tasks WHERE current_run_id=runs.id AND state='ACTIVE')`)
        .run(owner,pid,identity,now(this.store.db)+5000,id);
      if(Number(changed.changes)){this.event(run.task_id,id,'RunnerClaimed',{owner,pid});return true;}return false;
    });
  }
  heartbeat(id:string,owner:string):boolean {
    return Number(this.store.db.prepare(`UPDATE runs SET heartbeat_until=? WHERE id=? AND runner_owner=? AND state='RUNNING'
      AND EXISTS(SELECT 1 FROM scheduled_tasks WHERE current_run_id=runs.id AND state='ACTIVE')`).run(now(this.store.db)+5000,id,owner).changes)===1;
  }
  finish(id:string,owner:string,evidence:AgentEvidence,verdict:object):boolean {
    return transaction(this.store.db,()=>{
      const run=this.run(id)!;
      const changed=this.store.db.prepare(`UPDATE runs SET state='FINISHED',evidence_json=?,verdict_json=? WHERE id=? AND runner_owner=? AND state='RUNNING'
        AND EXISTS(SELECT 1 FROM scheduled_tasks WHERE current_run_id=runs.id AND state='ACTIVE')`).run(JSON.stringify(evidence),JSON.stringify(verdict),id,owner);
      this.event(run.task_id,id,Number(changed.changes)?'RunFinished':'StaleRunReceipt',verdict);return Number(changed.changes)===1;
    });
  }
  consume(id:string):boolean {
    return transaction(this.store.db,()=>{
      const run=this.run(id);if(!run||run.state!=='FINISHED')return false;
      const verdict=JSON.parse(run.verdict_json!);
      if(verdict.state==='INCOMPLETE')return false;
      const state=verdict.state==='PASS'?'COMPLETED':'BLOCKED';
      const result=this.store.db.prepare(`UPDATE scheduled_tasks SET state=?,blocked_reason=?,updated_at=? WHERE current_run_id=? AND state='ACTIVE'`)
        .run(state,state==='BLOCKED'?verdict.reason:null,now(this.store.db),id);
      if(Number(result.changes))this.event(run.task_id,id,'TaskSettled',{state});return Number(result.changes)===1;
    });
  }
  recover(id:string,reason:string):string|null {
    return transaction(this.store.db,()=>{
      const old=this.run(id);if(!old)return null;
      if(old.state==='FINISHED'&&JSON.parse(old.verdict_json!).state!=='INCOMPLETE')return null;
      const task=this.store.db.prepare("SELECT * FROM scheduled_tasks WHERE current_run_id=? AND state='ACTIVE'").get(id) as unknown as ScheduledTask|undefined;
      if(!task)return null;
      this.store.db.prepare('UPDATE tasks SET epoch=epoch+1 WHERE id=?').run(old.task_id);
      this.store.db.prepare("UPDATE runs SET state='SUPERSEDED' WHERE id=?").run(id);
      if(task.recovery_count>=task.max_recoveries||now(this.store.db)>=task.deadline){
        this.store.db.prepare("UPDATE scheduled_tasks SET state='BLOCKED',blocked_reason='RECOVERY_LIMIT' WHERE task_id=?").run(old.task_id);
        this.event(old.task_id,id,'RecoveryBlocked',{reason});return null;
      }
      const epoch=Number(this.store.db.prepare('SELECT epoch FROM tasks WHERE id=?').get(old.task_id)!.epoch);
      const next=this.insert(old.tenant_id,old.task_id,epoch,id,old.goal,old.input_json,old.intents_json,old.scopes_json);
      this.store.db.prepare('UPDATE scheduled_tasks SET current_run_id=?,recovery_count=recovery_count+1,updated_at=? WHERE task_id=?').run(next,now(this.store.db),old.task_id);
      this.event(old.task_id,next,'RecoveryPlanned',{priorRunId:id,reason});return next;
    });
  }
  input(id:string):AgentTask {
    const r=this.run(id)!;return {taskId:r.task_id,goal:r.goal,input:JSON.parse(r.input_json),
      recovery:r.previous_run_id?{priorRunId:r.previous_run_id,operationId:null,reason:'Previous execution interrupted; query current business facts'}:null};
  }
}

export class PersistentRequestBudget {
  readonly store:Store; readonly id:string;
  constructor(store:Store,id:string,limit:number|null) {
    this.store=store;this.id=id;
    if(limit!==null&&(!Number.isInteger(limit)||limit<1||limit>120))throw new Error('INVALID_CAMPAIGN_LIMIT');
    store.db.prepare('INSERT OR IGNORE INTO model_campaigns(id,request_limit) VALUES(?,?)').run(id,limit);
    if(store.db.prepare('SELECT request_limit FROM model_campaigns WHERE id=?').get(id)!.request_limit!==limit)throw new Error('CAMPAIGN_LIMIT_MISMATCH');
  }
  reserve():boolean { return Number(this.store.db.prepare('UPDATE model_campaigns SET used=used+1 WHERE id=? AND (request_limit IS NULL OR used<request_limit)').run(this.id).changes)===1; }
  get unlimited():boolean {return this.store.db.prepare('SELECT request_limit FROM model_campaigns WHERE id=?').get(this.id)!.request_limit===null;}
  get used():number { return Number(this.store.db.prepare('SELECT used FROM model_campaigns WHERE id=?').get(this.id)!.used); }
  get remaining():number { const r=this.store.db.prepare('SELECT * FROM model_campaigns WHERE id=?').get(this.id)!;return r.request_limit===null?Infinity:Number(r.request_limit)-Number(r.used); }
}
