import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Inventory } from './inventory.ts';
import { bearer, body, json, listen, loopbackUrl, sameSecret, validateOrigin } from './http.ts';
import { DomainError, type BusinessRequest, type Capabilities } from './types.ts';

const requestSchema = z.object({ intentKey: z.string().min(1).max(512), argsHash: z.string().min(1).max(512),
  tenantId: z.string().min(1).max(160), warehouseId: z.string().min(1).max(80), sku: z.string().min(1).max(80), quantity: z.number().int().positive().max(1_000_000) }).strict();
export async function inventoryServer(inventory: Inventory, token: string, profile: 'full' | 'weak' = 'full') {
  const capabilities: Capabilities = { inspect: profile === 'full', idempotent: profile === 'full', cancel: profile === 'full' };
  const fault = async (name: string, key: string) => {
    const mode = inventory.takeFault(name, key);
    if (mode === 'hold') {
      const deadline = Date.now() + 30_000;
      while (!inventory.fault(name)?.released && Date.now() < deadline) await delay(20);
      if (!inventory.fault(name)?.released) throw new DomainError('FAULT_BARRIER_TIMEOUT');
    }
    return mode;
  };
  return listen(async (req, res) => {
    validateOrigin(req);
    if (!sameSecret(bearer(req), token)) throw new DomainError('UNAUTHORIZED', 'Backend credential required', 401);
    if (req.url === '/capabilities' && req.method === 'GET') { json(res, capabilities); return; }
    if (req.method !== 'POST' || !['/reserve', '/inspect', '/cancel'].includes(req.url ?? '')) throw new DomainError('NOT_FOUND', 'Route not found', 404);
    const parsed = requestSchema.safeParse(await body(req));
    if (!parsed.success) throw new DomainError('INVALID_REQUEST');
    const input = parsed.data;
    if (req.url === '/inspect' && !capabilities.inspect) throw new DomainError('INSPECT_UNSUPPORTED');
    if (req.url === '/cancel' && !capabilities.cancel) throw new DomainError('CANCEL_UNSUPPORTED');
    if (req.url === '/reserve') await fault('before_apply', input.intentKey);
    const result = req.url === '/reserve' ? inventory.reserve(input) : req.url === '/cancel' ? inventory.cancel(input) : inventory.inspect(input);
    if (req.url === '/reserve' && await fault('after_commit_before_response', input.intentKey) === 'drop') { res.destroy(); return; }
    json(res, result);
  });
}
export class BackendClient {
  url: URL; token: string; timeoutMs: number;
  constructor(url: string, token: string, timeoutMs = 1500) { this.url = loopbackUrl(url); this.token = token; this.timeoutMs = timeoutMs; }
  async call(path: string, input?: BusinessRequest): Promise<unknown> {
    const response = await fetch(new URL(path, this.url), { method: input ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: input ? JSON.stringify(input) : undefined, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new DomainError('BACKEND_UNAVAILABLE');
    return response.json();
  }
  async capabilities(): Promise<Capabilities> {
    return z.object({ inspect: z.boolean(), idempotent: z.boolean(), cancel: z.boolean() }).strict().parse(await this.call('/capabilities'));
  }
}
