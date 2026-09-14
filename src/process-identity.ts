import { execFileSync } from 'node:child_process';
import type { RunRecord } from './run-store.ts';

export function processIdentity(pid:number):string|null {
  if(!Number.isSafeInteger(pid)||pid<=1)return null;
  try { const value=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();return value||null; }
  catch{return null;}
}
export function runnerAlive(run:RunRecord):boolean {
  return Boolean(run.runner_pid&&run.runner_identity&&processIdentity(run.runner_pid)===run.runner_identity);
}
// Same-host adapter only. Never kill an unverified recycled PID/group.
export function stopOwnedRunner(run:RunRecord,directory:string):boolean {
  if(!run.runner_pid||run.runner_pid<=1)return true;
  let owned=runnerAlive(run);
  if(!owned){
    const rows=execFileSync('/bin/ps',['-axo','pgid=,command='],{encoding:'utf8'}).split('\n');
    owned=rows.some(line=>{const match=line.trim().match(/^(\d+)\s+(.*)$/);return match&&Number(match[1])===run.runner_pid&&match[2].includes(`${directory}/agent-${run.id}/workspace`);});
  }
  if(!owned)return false;
  try{process.kill(-run.runner_pid,'SIGKILL');return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return true;throw e;}
}
