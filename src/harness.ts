import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRunDirectory } from './db.ts';
import { Store } from './store.ts';
import { Inventory } from './inventory.ts';
import { Controller } from './controller.ts';
import { Core } from './core.ts';
import type { ReservationInput } from './types.ts';

export async function until<T>(read: () => T | Promise<T>, accepts: (v: T) => boolean = Boolean, timeout = 12_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accepts(value)) return value; await delay(25); }
  throw new Error('Timed out waiting for observable condition');
}
export interface ProcessHandle { child: ChildProcess; pid: number; role: string; url?: string; errors: string }
export class Harness {
  dir: string; store: Store; inventory: Inventory; controller: Controller; core: Core;
  children: ProcessHandle[] = []; clients: Client[] = [];
  backendToken = randomBytes(32).toString('base64url'); backendUrl = ''; gatewayUrls: string[] = [];
  constructor() {
    this.dir = createRunDirectory(); this.store = new Store(this.dir); this.inventory = new Inventory(this.dir);
    this.controller = new Controller(this.store); this.core = new Core(this.store);
  }
  async start(profile: 'full' | 'weak' = 'full') {
    this.backendUrl = (await this.process('inventory', profile)).url!;
    this.gatewayUrls.push((await this.process('gateway')).url!);
    this.gatewayUrls.push((await this.process('gateway')).url!);
  }
  async process(role: 'inventory' | 'gateway' | 'worker', profile = 'full'): Promise<ProcessHandle> {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./process.ts', import.meta.url)), role, this.dir], {
      cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', POC_BACKEND_TOKEN: role === 'gateway' ? undefined : this.backendToken,
        POC_BACKEND_URL: role === 'worker' ? this.backendUrl : undefined, POC_BACKEND_PROFILE: profile },
    });
    const handle: ProcessHandle = { child, pid: child.pid!, role, errors: '' }; this.children.push(handle);
    child.stderr!.on('data', data => { handle.errors = (handle.errors + data).slice(-6000); });
    let stdout = ''; let initialized = false; let failed = false;
    child.on('error', () => { failed = true; });
    child.stdout!.on('data', data => {
      stdout += data;
      const end = stdout.indexOf('\n');
      if (!initialized && end !== -1) { const message = JSON.parse(stdout.slice(0, end)); handle.url = message.url; initialized = message.kind === 'ready'; }
    });
    await until(() => {
      if (failed || child.exitCode !== null) throw new Error(`${role} exited before readiness: ${handle.errors}`);
      return initialized;
    });
    return handle;
  }
  setup(input: ReservationInput, tenant = 'demo-tenant', stock = 10) {
    const task = this.controller.createTask(tenant); this.controller.addIntent(task, input);
    this.inventory.seed(tenant, input.warehouseId, input.sku, stock);
    return { task, token: this.controller.grant(task.id, [input.intentRef]), input };
  }
  async client(token: string, gateway = 0): Promise<Client> {
    const client = new Client({ name: 'durable-tool-runtime-demo', version: '0.1.0' }); this.clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', this.gatewayUrls[gateway]), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }
  async call(client: Client, name: string, args: object) {
    const response = await client.callTool({ name, arguments: { ...args } });
    return { error: Boolean(response.isError), data: response.structuredContent as Record<string, any> };
  }
  async kill(handle: ProcessHandle, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
    handle.child.kill(signal);
    try { await until(() => handle.child.exitCode !== null || handle.child.signalCode !== null, Boolean, 5000); }
    catch { handle.child.kill('SIGKILL'); await until(() => handle.child.signalCode !== null); }
  }
  async stopProcesses(): Promise<void> {
    await Promise.all(this.clients.map(c => c.close().catch(() => {})));
    await Promise.all(this.children.filter(c => c.role === 'worker').map(c => this.kill(c)));
    await Promise.all(this.children.filter(c => c.role !== 'worker').map(c => this.kill(c)));
  }
  async finalSnapshot() {
    await this.stopProcesses();
    return { governance: this.store.snapshot(), inventory: this.inventory.snapshot(), snapshotStage:'AFTER_PROCESS_SHUTDOWN' as const };
  }
  async close(): Promise<void> {
    await this.stopProcesses();
    this.store.close(); this.inventory.close();
  }
}
