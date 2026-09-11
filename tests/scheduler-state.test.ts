import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.ts';
import { Store } from '../src/store.ts';
import { Core } from '../src/core.ts';
import { Controller } from '../src/controller.ts';
import { RunStore, PersistentRequestBudget } from '../src/run-store.ts';
const binding={mode:'mock' as const,model:'fixture',modelProxyUrl:'http://127.0.0.1:12345/v1',mcpUrl:'http://127.0.0.1:12346/mcp',codexBinary:'/fixture',timeoutMs:1000};
function setup(){const h=new Harness();const f=h.setup({intentRef:'cold',warehouseId:'w',sku:'s',quantity:3});const rs=new RunStore(h.store);return {h,f,rs,id:rs.enqueue(f.token,'reserve',binding)};}
test('cold scanner rediscovers READY work; duplicate runner candidates have one winner',async()=>{
  const {h,f,rs,id}=setup();const reopened=new Store(h.dir);
  try{
    const cold=new RunStore(reopened);assert.equal(cold.tasks()[0].current_run_id,id);assert.equal(cold.input(id).input.intentRef,f.input.intentRef);
    assert.equal(cold.claimRunner(id,'A',111,'identity-a'),true);assert.equal(rs.claimRunner(id,'B',222,'identity-b'),false);
    assert.throws(()=>h.core.submit(f.token,f.input),/lost command authority/);
    const grant=new Controller(reopened).grant(f.task.id,[f.input.intentRef],['reserve','read'],10000,id);
    const operation=new Core(reopened).submit(grant,f.input);
    const next=cold.recover(id,'test confirmed runner loss')!;
    assert.equal(cold.input(next).recovery!.priorRunId,id);assert.equal(cold.claimRunner(next,'B',222,'identity-b'),true);
    assert.throws(()=>h.core.submit(grant,f.input),/lost command authority/);
    const nextToken=h.controller.grant(f.task.id,[f.input.intentRef],['read'],10000,next);
    assert.equal(h.core.get(nextToken,{intentRef:f.input.intentRef}).operationId,operation.operationId);
    assert.equal(cold.finish(id,'A',{mode:'mock',sessionId:'old',exitCode:0,stopReason:null,messages:[]},{state:'PASS'}),false);
    assert.equal(rs.tasks()[0].current_run_id,next);
  }finally{reopened.close();await h.close();}
});
test('completion persisted before scheduler acknowledgement is consumed once, not recovered',async()=>{
  const {h,rs,id}=setup();try{
    rs.claimRunner(id,'A',111,'identity');
    rs.finish(id,'A',{mode:'mock',sessionId:'done',exitCode:0,stopReason:null,messages:[]},{state:'PASS'});
    assert.equal(rs.recover(id,'stale scan'),null);
    assert.equal(rs.consume(id),true);assert.equal(rs.consume(id),false);
    assert.equal(rs.tasks()[0].state,'COMPLETED');
  }finally{await h.close();}
});
test('request and recovery budgets survive reopen and competing stores',async()=>{
  const {h,rs,id}=setup();const other=new Store(h.dir);try{
    const first=new PersistentRequestBudget(h.store,'campaign',2);const second=new PersistentRequestBudget(other,'campaign',2);
    assert.equal(first.reserve(),true);assert.equal(second.reserve(),true);assert.equal(first.reserve(),false);
    assert.equal(new PersistentRequestBudget(other,'campaign',2).used,2);
    assert.throws(()=>new PersistentRequestBudget(other,'campaign',3),/MISMATCH/);
    const b=rs.recover(id,'one')!;assert.equal(new RunStore(other).recover(id,'duplicate'),null);
    const c=rs.recover(b,'two')!;assert.equal(rs.recover(c,'third'),null);assert.equal(rs.tasks()[0].state,'BLOCKED');
  }finally{other.close();await h.close();}
});
test('unlimited request policy remains explicit and counted after reopen without changing capped history',async()=>{
  const h=new Harness();const other=new Store(h.dir);try{
    const capped=new PersistentRequestBudget(h.store,'old-capped',2);capped.reserve();capped.reserve();
    const free=new PersistentRequestBudget(h.store,'new-unlimited',null);
    for(let i=0;i<35;i++)assert.equal(free.reserve(),true);
    const reopened=new PersistentRequestBudget(other,'new-unlimited',null);
    assert.equal(reopened.unlimited,true);assert.equal(reopened.used,35);assert.equal(reopened.remaining,Infinity);
    assert.equal(capped.used,2);assert.equal(capped.reserve(),false);
  }finally{other.close();await h.close();}
});
