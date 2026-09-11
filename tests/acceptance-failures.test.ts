import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeAgent, type AgentEvidence } from '../src/agent-verdict.ts';
import { listen } from '../src/http.ts';

test('a received and corroborated authorization rejection can support denied, never reserved',()=>{
  const data={code:'INTENT_NOT_AUTHORIZED'};
  const calls=[{id:'c',grant_id:'g',run_id:'run',tool:'inventory_reservation_submit',args_json:'{"intentRef":"B"}',started_at:1,completed_at:2,
    result_json:JSON.stringify({structuredContent:data,isError:true})}];
  const run:AgentEvidence={mode:'live',sessionId:'session',exitCode:0,stopReason:null,messages:[{at:4,text:JSON.stringify({status:'denied',intentRef:'B',operationId:null,receiptId:null})}],
    toolEvents:[{at:3,item:{status:'failed',error:null,tool:'inventory_reservation_submit',arguments:{intentRef:'B'},result:{structured_content:data}}}]};
  assert.equal(judgeAgent(run,calls,'denied').agent,'PASS');
  assert.equal(judgeAgent(run,calls,'reserved').agent,'FAIL');
  assert.equal(judgeAgent({...run,toolEvents:[{...run.toolEvents![0],item:{...run.toolEvents![0].item,result:null,error:{message:'connection failure'}}}]},calls,'denied').agent,'FAIL');
});
test('a streaming handler error terminates the response instead of hanging until the caller timeout',async()=>{
  const endpoint=await listen(async(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: started\n\n');throw new Error('Injected stream failure');});
  try{
    await assert.rejects(async()=>{const response=await fetch(endpoint.url,{signal:AbortSignal.timeout(500)});await response.text();},
      (e:unknown)=>e instanceof Error&&e.name!=='TimeoutError');
  }finally{endpoint.server.closeAllConnections();await new Promise<void>(resolve=>endpoint.server.close(()=>resolve()));}
});
