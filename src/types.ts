export type ExecutionState = 'ACCEPTED' | 'DISPATCH_RECORDED' | 'OUTCOME_UNKNOWN' | 'APPLIED' | 'NOT_APPLIED';
export type InventoryState = 'RESERVED' | 'RELEASED' | 'CANCELLED' | 'CONSUMED' | 'REJECTED';
export interface ReservationInput { intentRef: string; warehouseId: string; sku: string; quantity: number }
export interface BusinessRequest {
  intentKey: string; argsHash: string; tenantId: string;
  warehouseId: string; sku: string; quantity: number;
}
export interface Observation extends BusinessRequest {
  found: boolean; state?: InventoryState; everApplied?: boolean;
  receiptId?: string; version?: number;
}
export interface Capabilities { inspect: boolean; idempotent: boolean; cancel: boolean }
export interface Operation {
  id: string; tenant_id: string; task_id: string; intent_ref: string;
  intent_key: string; business_key: string; args_hash: string; input_json: string;
  definition_digest: string; kind: 'reserve' | 'cancel'; parent_id: string | null;
  state: ExecutionState; desired_action: 'CONTINUE' | 'CANCEL';
  executor_epoch: number; lease_owner: string | null; lease_until: number | null;
  state_version: number; next_attempt_at: number | null; blocked_reason: string | null;
  result_json: string | null; created_at: number;
}
export interface Grant {
  id: string; tenant_id: string; task_id: string; run_id: string; task_epoch: number;
  expires_at: number; revoked: number; scopes_json: string; allowed_intent_refs_json: string;
}
export interface Task { id: string; tenant_id: string; epoch: number; revision: number }
export interface Intent {
  ref: string; tenant_id: string; task_id: string; business_key: string;
  input_json: string; definition_digest: string;
}
export class DomainError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message = code, httpStatus = 400) {
    super(message); this.code = code; this.httpStatus = httpStatus;
  }
}
