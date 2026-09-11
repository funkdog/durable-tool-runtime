import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MARKER = '.durable-tool-runtime-owned.json';
export function createRunDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'durable-tool-runtime-'));
  writeFileSync(join(dir, MARKER), JSON.stringify({ project: 'durable-tool-runtime', runId: randomUUID() }), { mode: 0o600 });
  return realpathSync(dir);
}
export function assertRunDirectory(dir: string): string {
  if (!isAbsolute(dir)) throw new Error('Data directory must be absolute');
  const actual = realpathSync(dir);
  if (actual !== resolve(dir) || lstatSync(dir).isSymbolicLink()) throw new Error('Symlinked data directory rejected');
  const marker = JSON.parse(readFileSync(join(actual, MARKER), 'utf8'));
  if (marker.project !== 'durable-tool-runtime' || !marker.runId) throw new Error('Not an owned POC directory');
  return actual;
}
export function openDatabase(dir: string, name: 'governance' | 'inventory'): DatabaseSync {
  const path = join(assertRunDirectory(dir), `${name}.sqlite`);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Symlinked database rejected');
  const db = new DatabaseSync(path);
  const version = String(db.prepare('select sqlite_version() as version').get()!.version).split('.').map(Number);
  if (version[0] < 3 || (version[0] === 3 && (version[1] < 51 || (version[1] === 51 && version[2] < 3)))) {
    db.close(); throw new Error('SQLite >= 3.51.3 is required (WAL-reset fix)');
  }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=500;');
  return db;
}
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('No async work inside SQLite transaction');
    db.exec('COMMIT'); return result;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
export function now(db: DatabaseSync): number {
  return Number(db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get()!.now);
}
export function digest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
