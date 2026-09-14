import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness } from '../src/harness.ts';

const h = new Harness();
try {
  await h.start();
  const input = { intentRef: 'order-42-line-1-v1', warehouseId: 'demo-warehouse', sku: 'CAT-001', quantity: 3 };
  const fixture = h.setup(input); await h.process('worker'); await h.process('worker');
  // Credentials are intentionally not logged or written into an existing client configuration.
  const credentialPath = join(h.dir, 'client-grant.json');
  writeFileSync(credentialPath, JSON.stringify({ url: h.gatewayUrls[0] + '/mcp', bearerToken: fixture.token, approvedInput: input,
    expiresInSeconds: 600, taskId: fixture.task.id }, null, 2), { mode: 0o600 });
  process.stdout.write(`隔离 POC 已启动：${h.gatewayUrls[0]}/mcp\nRunGrant（0600，10 分钟有效）：${credentialPath}\n批准的输入：${JSON.stringify(input)}\n`);
  process.stdout.write('未修改 Codex/MCP 配置，未启动付费模型。Ctrl-C 停止本次服务；数据库保留。\n');
  await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
} finally { await h.close(); }
