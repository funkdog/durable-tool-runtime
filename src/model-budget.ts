import { z } from 'zod';
import { body, json, listen, sameSecret } from './http.ts';
export const budgetSchema = z.object({
  model: z.string().min(1), maxRequests: z.number().int().min(1).max(30),
  maxOutputTokens: z.number().int().min(128).max(8192), maxInputBytes: z.number().int().min(1000).max(512_000),
  maxEstimatedUsd: z.number().positive().max(50), inputUsdPerMillion: z.number().positive(), outputUsdPerMillion: z.number().positive(),
  pricingSource: z.string().url(), pricingCheckedAt: z.string().datetime(),
}).strict();
export type ModelBudget = z.infer<typeof budgetSchema>;
export class BudgetLedger {
  policy: ModelBudget; requests = 0; reservedUsd = 0;
  constructor(value: ModelBudget) { this.policy = budgetSchema.parse(value); }
  admit(value: unknown) {
    const inputBytes = Buffer.byteLength(JSON.stringify(value));
    if (inputBytes > this.policy.maxInputBytes || this.requests >= this.policy.maxRequests) throw new Error('MODEL_REQUEST_BUDGET_EXHAUSTED');
    // Conservative local estimate, not a guarantee about provider-side hidden/billing tokens. No refund on missing usage.
    const estimate = ((inputBytes + 4096) * this.policy.inputUsdPerMillion + this.policy.maxOutputTokens * this.policy.outputUsdPerMillion) / 1_000_000;
    if (this.reservedUsd + estimate > this.policy.maxEstimatedUsd) throw new Error('MODEL_COST_RESERVATION_EXHAUSTED');
    this.requests++; this.reservedUsd += estimate;
  }
  snapshot() { return { requests: this.requests, reservedUsd: this.reservedUsd, policy: this.policy }; }
}
export async function modelProxy(key: string, token: string, budget: BudgetLedger, counter?: { reserve(): boolean }) {
  if (!key) throw new Error('POC_OPENAI_API_KEY is required; existing login tokens are not copied');
  return listen(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') { json(res, {}, 404); return; }
    if (!sameSecret(req.headers.authorization ?? '', `Bearer ${token}`)) { json(res, {}, 401); return; }
    const input = await body(req, budget.policy.maxInputBytes) as Record<string, unknown>;
    try { budget.admit(input); } catch (e) { json(res, { error: (e as Error).message }, 429); return; }
    if(counter&&!counter.reserve()){json(res,{error:'MODEL_REQUEST_BUDGET_EXHAUSTED'},429);return;}
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, model: budget.policy.model, store: false, stream: true, max_output_tokens: budget.policy.maxOutputTokens }),
      signal: AbortSignal.timeout(120_000) });
    if (!response.ok) { json(res, { error: 'UPSTREAM_MODEL_ERROR', status: response.status }, 502); await response.body?.cancel(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const reader = response.body!.getReader();
    try {
      while (!res.destroyed) { const next = await reader.read(); if (next.done) break; res.write(next.value); }
    } finally { await reader.cancel(); }
    res.end();
  });
}
