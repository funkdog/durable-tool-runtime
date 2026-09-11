import { randomUUID } from 'node:crypto';
import { listen, body, json, sameSecret } from './http.ts';
import type { ReservationInput } from './types.ts';

// Deliberately simulated Responses producer. NEVER used to claim real-model acceptance.
export async function modelFixture(input: ReservationInput, token: string, expected = 'reserved', initialTool: 'submit' | 'get' = 'submit') {
  let requests = 0; const toolNames = new Set<string>();
  const toolRefs = new Map<string, { name: string; namespace?: string }>();
  let toolShape: unknown = null; let lastOutput: unknown;
  const endpoint = await listen(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { json(res, {}, 404); return; }
    if (!sameSecret(req.headers.authorization ?? '', `Bearer ${token}`)) { json(res, {}, 401); return; }
    const request = await body(req, 512_000) as any; requests++;
    if (requests > 20) { json(res, { error: 'fixture_request_limit' }, 429); return; }
    toolShape = { requestKeys: Object.keys(request), inputTypes: request.input?.map((i: any) => ({type:i.type,role:i.role})) };
    const declared = [...(request.tools ?? []), ...(request.input ?? []).filter((i: any) => i.type === 'additional_tools').flatMap((i: any) => i.tools ?? [])];
    // Namespace wrappers are routing identities, not disposable grouping metadata.
    const tools = declared.flatMap((t: any) => t.tools
      ? t.tools.map((child: any) => ({ ...child, namespace: t.name })) : [t]);
    for (const t of tools) if (t.name) {
      toolNames.add(t.name); toolRefs.set(t.name, { name: t.name, ...(t.namespace ? { namespace: t.namespace } : {}) });
    }
    toolShape = { ...(toolShape as object), tools: tools.map((t: any) => ({ type: t.type, name: t.name, namespace: t.namespace })) };
    const outputs = (request.input ?? []).filter((i: any) => ['function_call_output', 'custom_tool_call_output'].includes(i.type));
    lastOutput = outputs.at(-1)?.output;
    const parse = (value: unknown): any => {
      try {
        if (Array.isArray(value)) return value.some(i => i.text) ? value.filter(i => i.text).map(i => parse(i.text)).filter(i => i !== null).at(-1) : value;
        // The native direct-MCP path decorates JSON with timing metadata.
        // Recognize only the observed envelope, never extract arbitrary prose as evidence.
        const text = typeof value === 'string' ? value.replace(/^Wall time: \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/, '') : value;
        const obj = typeof text === 'string' ? JSON.parse(text) : text;
        if ((obj as any)?.structuredContent) return (obj as any).structuredContent;
        if ((obj as any)?.content) return parse((obj as any).content);
        return obj;
      } catch { return null; }
    };
    const last = parse(outputs.at(-1)?.output);
    if (Array.isArray(last)) for (const tool of last) if (tool.name?.includes('governance')) toolNames.add(tool.name);
    const successful = requests > 1 && last?.executionState === 'APPLIED' && last?.observation?.state === 'RESERVED';
    const query = initialTool === 'get' || Boolean(last?.operationId);
    const name = [...toolNames].find(n => n.endsWith(query ? 'operation_get' : 'inventory_reservation_submit'));
    const codeMode = tools.some((t: any) => t.name === 'exec');
    if (!name && !codeMode) { json(res, { error: 'No governance tool advertised', names: [...toolNames] }, 400); return; }
    const item: any = successful ? { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify({ status: expected, intentRef: input.intentRef, operationId: last.operationId, receiptId: last.observation.receiptId, explanation: 'SIMULATED protocol fixture' }), annotations: [] }] }
      : codeMode ? { id: 'ct_' + randomUUID(), type: 'custom_tool_call', call_id: 'call_' + randomUUID(), name: 'exec', namespace: 'functions',
        input: name ? `text(await tools.${name}(${JSON.stringify(query ? { intentRef: input.intentRef } : input)}));`
          : 'text(ALL_TOOLS.filter(t=>t.name.includes("governance")).map(t=>({name:t.name})));' }
      : { id: 'fc_' + randomUUID(), type: 'function_call', call_id: 'call_' + randomUUID(), ...toolRefs.get(name!),
        arguments: JSON.stringify(query ? { intentRef: input.intentRef } : input), status: 'completed' };
    const id = 'resp_' + randomUUID(); let seq = 0;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
    emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item: { ...item, ...(item.type === 'message' ? { content: [] } : { arguments: '' }), status: 'in_progress' } });
    if (item.type === 'message') {
      emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
      emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text });
    } else if (item.type === 'function_call') emit('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } });
    res.end();
  });
  return { ...endpoint, diagnostics: () => ({ mode: 'mock', requests, toolNames: [...toolNames], toolShape, lastOutput }) };
}
