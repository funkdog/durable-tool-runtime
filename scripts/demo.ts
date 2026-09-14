import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness, until } from '../src/harness.ts';
import { businessRequest } from '../src/worker.ts';

const h = new Harness(); const timeline: object[] = [];
const root = fileURLToPath(new URL('..', import.meta.url));
const record = (title: string, detail: object) => {
  const entry = { at: new Date().toISOString(), title, ...detail }; timeline.push(entry);
  process.stdout.write(`\n${timeline.length}. ${title}\n${JSON.stringify(detail, null, 2)}\n`);
};
const state = (id: string) => h.core.view(h.store.get(id)!);
let outcome = 'FAILED'; let weakEvidence: object | undefined;
try {
  process.stdout.write('Durable Tool Runtime · 真实 MCP / 多进程 / SQLite 演示；业务后端是隔离库存样例，不是生产服务。\n');
  await h.start();
  const f = h.setup({ intentRef: 'order-42-line-1-v1', warehouseId: 'demo-warehouse', sku: 'CAT-001', quantity: 3 });
  const c1 = await h.client(f.token); const c2 = await h.client(f.token, 1);
  record('工具发现与可信意图', { tools: (await c1.listTools()).tools.map(t => t.name), approvedInput: f.input, initialStock: 10 });
  const [a, b] = await Promise.all([h.call(c1, 'inventory_reservation_submit', f.input), h.call(c2, 'inventory_reservation_submit', f.input)]);
  assert.equal(a.error, false); assert.equal(a.data.operationId, b.data.operationId);
  const id = String(a.data.operationId); const op = h.store.get(id)!;
  record('两个网关并发受理：只有一个 Operation', { operationIds: [a.data.operationId, b.data.operationId], state: state(id) });
  h.inventory.armFault('after_commit_before_response', op.business_key, 'hold');
  const workerA = await h.process('worker');
  await until(() => h.inventory.fault('after_commit_before_response')?.hits === 1);
  const saved = h.core.checkpoint(f.token);
  assert.equal(h.inventory.stock(f.task.tenant_id, f.input.warehouseId, f.input.sku), 7);
  record('下游已扣减，但治理账本尚未取得结果', { checkpoint: saved, governance: state(id), downstream: h.inventory.inspect(businessRequest(op)), availableStock: 7 });
  await h.kill(workerA, 'SIGKILL'); await c1.close();
  const workerB = await h.process('worker');
  await until(() => h.store.get(id)?.state === 'APPLIED');
  assert.equal(h.inventory.effectCount(op.business_key, 'reserve'), 1);
  record('杀掉 worker A，B 接管并对账恢复', { killedPid: workerA.pid, replacementPid: workerB.pid, state: state(id), reserveEffects: 1 });
  h.inventory.releaseFault('after_commit_before_response');
  h.controller.takeover(f.task.id, 1);
  const stale = await h.call(c2, 'inventory_reservation_submit', f.input);
  assert.equal(stale.data.code, 'STALE_TASK_EPOCH');
  const newToken = h.controller.grant(f.task.id, [f.input.intentRef]); const c3 = await h.client(newToken);
  const restored = await h.call(c3, 'operation_get', { intentRef: f.input.intentRef });
  assert.equal(restored.data.operationId, id);
  const checkpointRestored = h.core.restoreCheckpoint(newToken, saved.runId);
  assert.equal(checkpointRestored.operations[0].operationId, id);
  record('Agent 换代：旧命令被拒绝，新授权找回旧操作', { staleProducer: stale.data, restored: restored.data, checkpointRestored });
  await h.call(c3, 'operation_cancel_request', { operationId: id, reason: '演示用户撤销订单' });
  await until(() => state(id).cancellation?.executionState === 'APPLIED');
  await h.call(c3, 'operation_cancel_request', { operationId: id });
  assert.equal(h.inventory.stock(f.task.tenant_id, f.input.warehouseId, f.input.sku), 10);
  assert.equal(h.inventory.effectCount(op.business_key, 'release'), 1);
  record('取消产生独立补偿操作，释放一次，保留原执行事实', { state: state(id), releaseEffects: 1, availableStock: 10 });

  await h.kill(workerB);
  const late = { ...f.input, intentRef: 'order-43-line-1-v1' }; h.controller.addIntent(f.task, late);
  const denied = await h.call(c3, 'inventory_reservation_submit', late);
  assert.equal(denied.error, true); assert.equal(denied.data.code, 'INTENT_NOT_AUTHORIZED');
  const lateClient = await h.client(h.controller.grant(f.task.id, [late.intentRef]));
  const lateResponse = await h.call(lateClient, 'inventory_reservation_submit', late); const lateOp = h.store.get(lateResponse.data.operationId)!;
  h.inventory.armFault('before_apply', lateOp.business_key, 'hold');
  await h.process('worker'); await until(() => h.inventory.fault('before_apply')?.hits === 1);
  await h.call(lateClient, 'operation_cancel_request', { operationId: lateOp.id }); await h.process('worker');
  await until(() => state(lateOp.id).cancellation?.executionState === 'APPLIED');
  h.inventory.releaseFault('before_apply'); await until(() => h.store.get(lateOp.id)?.state === 'NOT_APPLIED');
  assert.equal(h.inventory.effectCount(lateOp.business_key, 'reserve'), 0);
  record('新意图重新授权；取消先封闭意图，迟到写请求不能复活它', { oldGrantRejected: denied.data, state: state(lateOp.id), reserveEffects: 0,
    availableStock: h.inventory.stock(f.task.tenant_id, f.input.warehouseId, f.input.sku) });

  const events = h.store.snapshot().events;
  for (const event of [...events].reverse()) { h.store.deliver('demo-ui', String(event.id)); assert.equal(h.store.deliver('demo-ui', String(event.id)), false); }
  record('重复、乱序投递后重建读模型', { eventCount: events.length, uniqueDeliveries: h.store.snapshot().deliveries.length, projections: h.store.snapshot().projections });

  const weak = new Harness();
  try {
    await weak.start('weak'); const wf = weak.setup({ ...f.input, intentRef: 'weak-backend-case' });
    const client = await weak.client(wf.token); const response = await weak.call(client, 'inventory_reservation_submit', wf.input);
    const wo = weak.store.get(response.data.operationId)!;
    weak.inventory.armFault('after_commit_before_response', wo.business_key, 'drop'); await weak.process('worker');
    await until(() => weak.store.get(wo.id)?.blocked_reason === 'RECONCILIATION_UNSUPPORTED');
    assert.equal(weak.store.get(wo.id)?.state, 'OUTCOME_UNKNOWN');
    record('能力不足的诚实失败：未知就停住，不猜成功、不盲重试', { state: weak.core.view(weak.store.get(wo.id)!), actualFixtureStock: 7,
      note: '库存真值仅由演示裁判查看；worker 在此能力档位无法取得该证据。' });
    weakEvidence = { directory: weak.dir, ...await weak.finalSnapshot() };
  } finally { await weak.close(); }
  outcome = 'PASSED';
} finally {
  const finalState = await h.finalSnapshot();
  const report = { outcome, generatedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirtyWorktree: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    truthLabel: 'Real MCP SDK client/server and processes; isolated example business backend; no live model or production service',
    directory: h.dir, processIds: h.children.map(c => ({ role: c.role, pid: c.pid })), timeline,
    ...finalState, weakBackend: weakEvidence };
  writeFileSync(join(h.dir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  writeFileSync(join(h.dir, 'report.md'), `# Durable Tool Runtime 演示：${outcome}\n\n${report.truthLabel}\n\n` + timeline.map((item: any, i) => `## ${i + 1}. ${item.title}\n\n\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\`\n`).join('\n'), { mode: 0o600 });
  await h.close();
  process.stdout.write(`\n${outcome} · 证据保留在 ${h.dir}/report.md\n数据库及 JSON 报告均保留；所有本次启动的服务已停止。\n`);
}
