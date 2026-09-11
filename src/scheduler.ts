import { spawn } from 'node:child_process';
import { openSync, closeSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.ts';
import { RunStore } from './run-store.ts';
import { now, assertRunDirectory } from './db.ts';
import { runnerAlive, stopOwnedRunner } from './process-identity.ts';

export async function testBarrier(directory:string,role:string,phase:string,detail:unknown) {
  if(process.env[`POC_${role.toUpperCase()}_TEST_BARRIER`]!==phase)return;
  writeFileSync(join(directory,`${role}-${phase}-${process.pid}.json`),JSON.stringify({pid:process.pid,phase,detail}),{mode:0o600});
  while(!existsSync(join(directory,`release-${role}-${phase}`)))await delay(20);
}
export async function schedulerMain(directory:string):Promise<void> {
  const dir=assertRunDirectory(directory);const store=new Store(dir);const runs=new RunStore(store);
  let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  process.stdout.write(JSON.stringify({kind:'ready',role:'scheduler',pid:process.pid})+'\n');
  try{while(!stopping){
    for(const task of runs.tasks().filter(t=>t.state==='ACTIVE')){
      const run=runs.run(task.current_run_id)!;
      if(run.state==='FINISHED'){
        await testBarrier(dir,'scheduler','before_consume',{runId:run.id});
        if(!runs.consume(run.id))runs.recover(run.id,'INCOMPLETE_RUNTIME');
      }else if(now(store.db)>=task.deadline){
        runs.recover(run.id,'DEADLINE');stopOwnedRunner(run,dir);
      }else if(run.state==='RUNNING'&&(!runnerAlive(run)||(run.heartbeat_until??0)<=now(store.db))){
        // Fence before stopping a stale process; accepted worker operations are not cancelled.
        runs.recover(run.id,'RUNNER_LOST');stopOwnedRunner(run,dir);
      }else if(run.state==='READY'){
        if(run.launches>=5){runs.recover(run.id,'LAUNCH_LIMIT');continue;}
        if(!runs.reserveLaunch(run.id))continue;
        await testBarrier(dir,'scheduler','before_launch',{runId:run.id});
        const owner=randomUUID();const log=openSync(join(dir,`runner-${run.id}-${owner}.log`),'a',0o600);
        try{
          const child=spawn(process.execPath,[fileURLToPath(new URL('./process.ts',import.meta.url)),'runner',dir,run.id,owner],{
            detached:true,stdio:['ignore',log,log],env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',POC_MODEL_PROXY_TOKEN:process.env.POC_MODEL_PROXY_TOKEN,
              POC_RUNNER_TEST_BARRIER:process.env.POC_RUNNER_TEST_BARRIER}});
          child.on('error',()=>runs.event(run.task_id,run.id,'SpawnFailed'));child.unref();
        }finally{closeSync(log);}
        await testBarrier(dir,'scheduler','after_spawn',{runId:run.id});
      }
    }
    await delay(100);
  }}finally{store.close();}
}
