import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DomainError } from './types.ts';

export function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || [3003, 3004, 6399].includes(Number(url.port)) || url.username || url.password) throw new Error('Only explicit non-reserved loopback endpoints are allowed');
  return url;
}
export function bearer(req: IncomingMessage): string {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization ?? '');
  if (!match) throw new DomainError('UNAUTHORIZED', 'Bearer grant required', 401);
  return match[1];
}
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y);
}
export function validateOrigin(req: IncomingMessage): void {
  const port = req.socket.localPort;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host ?? '')) throw new DomainError('INVALID_HOST', 'Invalid host', 403);
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) throw new DomainError('INVALID_ORIGIN', 'Invalid origin', 403);
}
export async function body(req: IncomingMessage, maxBytes = 65_536): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new DomainError('JSON_REQUIRED', 'JSON required', 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > maxBytes) throw new DomainError('BODY_TOO_LARGE', 'Body too large', 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('INVALID_JSON'); }
}
export function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
}
export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => {
    handler(req, res).catch(e => {
      if (!res.headersSent && !res.destroyed) json(res, { code: e instanceof DomainError ? e.code : 'INTERNAL_ERROR' }, e instanceof DomainError ? e.httpStatus : 500);
      else if (!res.destroyed && !res.writableEnded) res.destroy();
    });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No TCP address');
  if ([3003, 3004, 6399].includes(address.port)) { server.close(); throw new Error('Reserved port rejected'); }
  return { server, url: `http://127.0.0.1:${address.port}` };
}
