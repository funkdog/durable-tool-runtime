import { digest } from './db.ts';
export interface CallEvidence { id: string; grant_id: string; run_id: string; tool: string; args_json: string; started_at: number; completed_at: number | null; result_json: string | null }
export interface AgentEvidence {
  mode: 'live' | 'mock'; sessionId: string | null; exitCode: number | null; stopReason: string | null;
  messages: { text: string; at: number }[]; toolEvents?: { item: any; at: number }[];
  errors?: { message:string; at:number }[];
}
export function judgeAgent(agent: AgentEvidence, calls: CallEvidence[], expected = 'reserved') {
  if (agent.mode !== 'live') return {agent:'NOT_RUN',reason:'Model responses were simulated; protocol evidence only'};
  return verifyAgentEvidence(agent,calls,expected);
}
export function verifyAgentEvidence(agent: AgentEvidence, calls: CallEvidence[], expected = 'reserved') {
  const verdict = (value: string, reason: string) => ({ agent: value, reason });
  if (agent.stopReason || agent.exitCode !== 0 || !agent.sessionId) return verdict('INCOMPLETE', agent.stopReason ?? 'Runtime did not complete');
  if (!calls.length || !agent.toolEvents?.length) return verdict('FAIL', 'No correlated runtime and gateway tool evidence');
  const final = agent.messages.at(-1); if (!final) return verdict('FAIL', 'No final response');
  let answer: any;
  try { answer = JSON.parse(final.text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return verdict('FAIL', 'Final response is not the required JSON'); }
  if (answer.status !== expected) return verdict('FAIL', 'Final state does not satisfy scenario requirement');
  const results = calls.filter(c => c.completed_at !== null && c.completed_at <= final.at && c.result_json)
    .map(c => JSON.parse(c.result_json!).structuredContent);
  const supports = (r: any) => {
    if (!r) return false;
    if (expected === 'denied') return ['INTENT_NOT_AUTHORIZED', 'SCOPE_DENIED', 'STALE_TASK_EPOCH', 'STALE_RUN', 'NOT_FOUND'].includes(r.code);
    if (r.operationId !== answer.operationId || r.intentRef !== answer.intentRef) return false;
    if (expected === 'unknown') return r.executionState === 'OUTCOME_UNKNOWN';
    if (expected === 'not_applied') return r.executionState === 'NOT_APPLIED' || r.cancellation?.executionState === 'NOT_APPLIED';
    if (expected === 'reserved') return r.executionState === 'APPLIED' && r.observation?.state === 'RESERVED' && r.observation.receiptId === answer.receiptId;
    return (r.cancellation?.executionState === 'APPLIED' && ['RELEASED','CANCELLED','REJECTED'].includes(r.observation?.state) && r.observation.receiptId === answer.receiptId)
      || (r.executionState === 'NOT_APPLIED' && r.desiredAction === 'CANCEL' && answer.receiptId === null);
  };
  const supported = results.some(supports);
  // A gateway result can precede a dropped response: require the runtime to have actually received the evidence too.
  const runtimeSaw = agent.toolEvents.some(e => {
    const rejectedTool = e.item.status === 'failed' && expected === 'denied' && e.item.error == null;
    if (e.at > final.at || (e.item.status !== 'completed' && !rejectedTool)) return false;
    const actual = e.item.result?.structured_content ?? e.item.result?.structuredContent;
    if (!supports(actual)) return false;
    return calls.some(c => c.tool === e.item.tool && c.completed_at !== null && c.completed_at <= e.at
      && digest(JSON.parse(c.args_json)) === digest(e.item.arguments)
      && c.result_json && (!rejectedTool || JSON.parse(c.result_json).isError === true)
      && digest(JSON.parse(c.result_json).structuredContent) === digest(actual));
  });
  return supported && runtimeSaw ? verdict('PASS', 'Final claim matches prior tool evidence; narrative still subject to independent review')
    : verdict('FAIL', 'No matching evidence available before the final claim');
}
