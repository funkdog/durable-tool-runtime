import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertRunDirectory } from './db.ts';
import { Store } from './store.ts';
import { Core } from './core.ts';
import { Inventory } from './inventory.ts';
import { inventoryServer, BackendClient } from './backend.ts';
import { mcpServer } from './mcp.ts';
import { Worker } from './worker.ts';

const [role, directory] = process.argv.slice(2);
const dir = assertRunDirectory(directory);
let stopping = false;
const shutdown = () => { stopping = true; };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
const ready = (url?: string) => process.stdout.write(JSON.stringify({ kind: 'ready', role, pid: process.pid, url }) + '\n');
if (role === 'inventory' || role === 'gateway') {
  const data = role === 'inventory' ? new Inventory(dir) : new Store(dir);
  const token = process.env.POC_BACKEND_TOKEN;
  if (role === 'inventory' && !token) throw new Error('Missing backend token');
  const endpoint = role === 'inventory'
    ? await inventoryServer(data as Inventory, token!, process.env.POC_BACKEND_PROFILE === 'weak' ? 'weak' : 'full')
    : await mcpServer(new Core(data as Store));
  ready(endpoint.url);
  while (!stopping) await delay(50);
  endpoint.server.closeAllConnections(); await new Promise<void>(resolve => endpoint.server.close(() => resolve()));
  // Fault-barrier requests are test-only and can remain pending after sockets close.
  data.close(); process.exit(0);
} else if (role === 'worker') {
  if (!process.env.POC_BACKEND_URL || !process.env.POC_BACKEND_TOKEN) throw new Error('Missing backend binding');
  const store = new Store(dir);
  const worker = new Worker(store, new BackendClient(process.env.POC_BACKEND_URL, process.env.POC_BACKEND_TOKEN), randomUUID());
  ready();
  while (!stopping) {
    try { await worker.tick(); } catch { process.stderr.write('Worker iteration failed; durable state retained\n'); }
    await delay(30);
  }
  store.close();
} else if(role==='scheduler') {
  await (await import('./scheduler.ts')).schedulerMain(dir);
} else if(role==='runner') {
  const [runId,owner]=process.argv.slice(4);
  if(!runId||!owner)throw new Error('Run identity required');
  await (await import('./runner.ts')).runnerMain(dir,runId,owner);
} else throw new Error('Unsupported process role');
