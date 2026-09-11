import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ZodError } from 'zod';
import { Core } from './core.ts';
import { submitSchema, lookupSchema, cancelSchema } from './catalog.ts';
import { bearer, body, json, listen, validateOrigin } from './http.ts';
import { DomainError } from './types.ts';
import { CallAudit } from './call-audit.ts';
import { setTimeout as delay } from 'node:timers/promises';

function result(action: () => object) {
  try { const data = { ...action() }; return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data }; }
  catch (e) {
    const data = { code: e instanceof DomainError ? e.code : e instanceof ZodError ? 'INVALID_ARGUMENTS' : 'TEMPORARY_ERROR' };
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, isError: true };
  }
}
export async function mcpServer(core: Core) {
  const audit = new CallAudit(core.store);
  return listen(async (req, res) => {
    validateOrigin(req);
    if (req.url !== '/mcp') throw new DomainError('NOT_FOUND', 'Route not found', 404);
    const token = bearer(req); const grant = core.authenticate(token);
    if (req.method !== 'POST') { json(res, { code: 'METHOD_NOT_ALLOWED' }, 405); return; }
    const message = await body(req);
    const server = new McpServer({ name: 'durable-tool-runtime', version: '0.1.0' });
    const scopes = JSON.parse(grant.scopes_json) as string[];
    const invoke = async (name: string, input: unknown, action: () => object) => {
      const id = audit.start(grant, name, input);
      const output = result(action); audit.finish(id, output);
      const fault = audit.take(name);
      if (fault === 'drop') res.destroy();
      if (fault === 'hold') {
        const deadline = Date.now() + 30_000;
        while (!res.destroyed && !audit.fault(name)?.released && Date.now() < deadline) await delay(20);
        if (!audit.fault(name)?.released) res.destroy();
      }
      return output;
    };
    // The listing is a projection. The Core repeats authoritative checks at use time.
    if (scopes.includes('reserve')) server.registerTool('inventory_reservation_submit', {
      description: 'Use when executing a controller-approved inventory reservation intent. Durably accepts one operation and schedules an inventory write. Not for status lookup or cancellation; use operation_get or operation_cancel_request. Output: operationId and executionState, not immediate business success. After timeout reuse the same intentRef; do not invent a new intent.',
      inputSchema: submitSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, input => invoke('inventory_reservation_submit', input, () => core.submit(token, input)));
    if (scopes.includes('read')) server.registerTool('operation_get', {
      description: 'Use to look up a reservation after submission, timeout, restart or cancellation. Read-only; does not submit, retry or cancel work. Supply exactly one of operationId or intentRef. Output: durable execution facts, latest recorded observation and separate cancellation status. OUTCOME_UNKNOWN is not failure or safe-retry permission.',
      inputSchema: lookupSchema, annotations: { readOnlyHint: true, openWorldHint: false },
    }, input => invoke('operation_get', input, () => core.get(token, input)));
    if (scopes.includes('cancel')) server.registerTool('operation_cancel_request', {
      description: 'Use when the user requests cancellation of an accepted reservation. Durably records cancellation and, if needed, schedules a separate compensating inventory release. Not for RPC abort or erasing execution history; not instantaneous rollback. Output: original operation and separate cancellation status. Query operation_get until resolved or blocked.',
      inputSchema: cancelSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, input => invoke('operation_cancel_request', input, () => core.cancel(token, input)));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport); await transport.handleRequest(req, res, message);
  });
}
