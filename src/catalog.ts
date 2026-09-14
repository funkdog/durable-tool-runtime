import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { digest } from './db.ts';
import { DomainError, type BusinessRequest, type Observation, type ReservationInput } from './types.ts';

export const submitSchema = z.object({
  intentRef: z.string().trim().min(1).max(160).describe('Controller-approved stable business intent, e.g. order-42-line-1-v1; reuse after timeout.'),
  warehouseId: z.string().trim().min(1).max(80).describe('Approved warehouse identifier, e.g. demo-warehouse.'),
  sku: z.string().trim().min(1).max(80).describe('Approved stock-keeping unit, e.g. CAT-001.'),
  quantity: z.number().int().positive().max(1_000_000).describe('Number of units, integer 1..1000000, exactly matching the approved intent.'),
}).strict();
export const lookupSchema = z.object({ operationId: z.string().uuid().optional().describe('Operation UUID returned by submit; omit if using intentRef.'),
  intentRef: z.string().min(1).max(160).optional().describe('Original approved intent; use when the submit response was lost; omit operationId.') }).strict();
export const cancelSchema = z.object({ operationId: z.string().uuid().describe('Original reservation operation UUID, not a compensation UUID.'),
  reason: z.string().max(200).optional().describe('Optional audit reason, at most 200 characters; do not include secrets.') }).strict();
export interface Definition {
  toolId: string; definitionVersion: number; implementationRef: string;
  executionMode: 'durable_async'; authorizationPolicy: 'approved_intent';
  consistencyRequirement: 'backend_atomic'; unknownPolicy: 'reconcile_or_block';
}
export const definition: Definition = Object.freeze({
  toolId: 'inventory.reserve', definitionVersion: 1, implementationRef: 'inventory.reservation.v1',
  executionMode: 'durable_async', authorizationPolicy: 'approved_intent',
  consistencyRequirement: 'backend_atomic', unknownPolicy: 'reconcile_or_block',
});
const observationSchema = z.object({
  intentKey: z.string(), argsHash: z.string(), tenantId: z.string(), warehouseId: z.string(), sku: z.string(),
  quantity: z.number().int().positive(), found: z.boolean(),
  state: z.enum(['RESERVED', 'RELEASED', 'CANCELLED', 'CONSUMED', 'REJECTED']).optional(),
  everApplied: z.boolean().optional(), receiptId: z.string().optional(), version: z.number().int().positive().optional(),
}).strict();
const implementation = {
  normalize(value: unknown): ReservationInput { return submitSchema.parse(value); },
  authorize(input: ReservationInput, approved: ReservationInput) {
    if (digest(input) !== digest(approved)) throw new DomainError('INTENT_ARGUMENT_MISMATCH');
  },
  scope(tenant: string, input: ReservationInput) { return `${tenant}/${input.warehouseId}/${input.sku}`; },
  intentKey(tenant: string, ref: string) { return `reserve:${digest([tenant, 'inventory.reserve', ref])}`; },
  classify(expected: BusinessRequest, raw: unknown, kind: 'reserve' | 'cancel') {
    const checked = observationSchema.safeParse(raw);
    if (!checked.success) throw new DomainError('INVALID_EVIDENCE');
    const observation = checked.data;
    for (const key of ['intentKey', 'argsHash', 'tenantId', 'warehouseId', 'sku', 'quantity'] as const) {
      if (observation[key] !== expected[key]) throw new DomainError('EVIDENCE_MISMATCH');
    }
    if (!observation.found) return { state: 'OUTCOME_UNKNOWN' as const, observation };
    if (!observation.state || !observation.receiptId || !observation.version || observation.everApplied === undefined) throw new DomainError('INCOMPLETE_EVIDENCE');
    const hadEffect = ['RESERVED', 'RELEASED', 'CONSUMED'].includes(observation.state);
    if (hadEffect !== observation.everApplied) throw new DomainError('INCONSISTENT_EVIDENCE');
    if (kind === 'cancel') {
      if (observation.state === 'RESERVED') return { state: 'OUTCOME_UNKNOWN' as const, observation };
      return { state: observation.state === 'CONSUMED' ? 'NOT_APPLIED' as const : 'APPLIED' as const, observation };
    }
    return { state: hadEffect ? 'APPLIED' as const : 'NOT_APPLIED' as const, observation };
  },
};
const implementations: Readonly<Record<string, typeof implementation>> = { 'inventory.reservation.v1': implementation };
export class Catalog {
  definition: Definition;
  implementation: typeof implementation;
  digest: string;
  constructor(def: Definition = definition) {
    const bound = implementations[def.implementationRef];
    if (!bound || def.toolId !== 'inventory.reserve' || def.definitionVersion !== 1 || def.executionMode !== 'durable_async'
      || def.authorizationPolicy !== 'approved_intent' || def.consistencyRequirement !== 'backend_atomic' || def.unknownPolicy !== 'reconcile_or_block') {
      throw new DomainError('UNSUPPORTED_DEFINITION');
    }
    this.definition = Object.freeze({ ...def }); this.implementation = bound;
    this.digest = digest({ definition: def, implementation: readFileSync(new URL('./catalog.ts', import.meta.url), 'utf8') });
  }
}
