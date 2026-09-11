import { randomUUID } from 'node:crypto';
import { openDatabase, transaction } from './db.ts';
import { DomainError, type BusinessRequest, type Observation, type InventoryState } from './types.ts';

interface Row {
  tenant: string; intent_key: string; args_hash: string; warehouse: string; sku: string;
  quantity: number; state: InventoryState; ever_applied: number; receipt_id: string; version: number;
}
export class Inventory {
  db: ReturnType<typeof openDatabase>;
  constructor(dataDir: string) {
    this.db = openDatabase(dataDir, 'inventory');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stock (
        tenant TEXT, warehouse TEXT, sku TEXT, initial INTEGER NOT NULL CHECK(initial>=0),
        available INTEGER NOT NULL CHECK(available>=0), PRIMARY KEY(tenant,warehouse,sku));
      CREATE TABLE IF NOT EXISTS reservations (
        tenant TEXT, intent_key TEXT, args_hash TEXT NOT NULL, warehouse TEXT NOT NULL, sku TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity>0), state TEXT NOT NULL, ever_applied INTEGER NOT NULL,
        receipt_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(tenant,intent_key));
      CREATE TABLE IF NOT EXISTS effects (
        tenant TEXT, intent_key TEXT, kind TEXT, quantity INTEGER NOT NULL,
        PRIMARY KEY(tenant,intent_key,kind));
      CREATE TABLE IF NOT EXISTS faults (
        name TEXT PRIMARY KEY, intent_key TEXT, mode TEXT, hits INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0);
    `);
  }
  seed(tenant: string, warehouse: string, sku: string, quantity: number): void {
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new DomainError('INVALID_STOCK');
    this.db.prepare('INSERT INTO stock VALUES(?,?,?,?,?)').run(tenant, warehouse, sku, quantity, quantity);
  }
  private validate(r: BusinessRequest): void {
    if (!Number.isSafeInteger(r.quantity) || r.quantity <= 0 || r.quantity > 1_000_000) throw new DomainError('INVALID_QUANTITY');
    for (const key of ['tenantId', 'warehouseId', 'sku', 'intentKey', 'argsHash'] as const) {
      if (typeof r[key] !== 'string' || r[key].length < 1 || r[key].length > 512) throw new DomainError('INVALID_REQUEST');
    }
  }
  private row(r: BusinessRequest): Row | undefined {
    const row = this.db.prepare('SELECT * FROM reservations WHERE tenant=? AND intent_key=?').get(r.tenantId, r.intentKey) as unknown as Row | undefined;
    if (row && (row.args_hash !== r.argsHash || row.warehouse !== r.warehouseId || row.sku !== r.sku || row.quantity !== r.quantity)) throw new DomainError('INTENT_CONFLICT');
    return row;
  }
  private observation(r: BusinessRequest, row?: Row): Observation {
    return row ? { ...r, found: true, state: row.state, everApplied: Boolean(row.ever_applied), receiptId: row.receipt_id, version: row.version } : { ...r, found: false };
  }
  inspect(r: BusinessRequest): Observation {
    this.validate(r); return this.observation(r, this.row(r));
  }
  reserve(r: BusinessRequest): Observation {
    this.validate(r);
    return transaction(this.db, () => {
      const existing = this.row(r);
      if (existing) return this.observation(r, existing);
      const changed = this.db.prepare('UPDATE stock SET available=available-? WHERE tenant=? AND warehouse=? AND sku=? AND available>=?')
        .run(r.quantity, r.tenantId, r.warehouseId, r.sku, r.quantity);
      const applied = Number(changed.changes) === 1;
      this.insert(r, applied ? 'RESERVED' : 'REJECTED', applied);
      if (applied) this.effect(r, 'reserve');
      return this.inspect(r);
    });
  }
  cancel(r: BusinessRequest): Observation {
    this.validate(r);
    return transaction(this.db, () => {
      const existing = this.row(r);
      if (!existing) this.insert(r, 'CANCELLED', false);
      else if (existing.state === 'RESERVED') {
        const changed = this.db.prepare('UPDATE stock SET available=available+? WHERE tenant=? AND warehouse=? AND sku=?')
          .run(r.quantity, r.tenantId, r.warehouseId, r.sku);
        if (Number(changed.changes) !== 1) throw new DomainError('MISSING_RESOURCE');
        this.db.prepare("UPDATE reservations SET state='RELEASED',version=version+1 WHERE tenant=? AND intent_key=?").run(r.tenantId, r.intentKey);
        this.effect(r, 'release');
      }
      return this.inspect(r);
    });
  }
  consume(r: BusinessRequest): Observation {
    this.validate(r);
    return transaction(this.db, () => {
      const existing = this.row(r);
      if (!existing || existing.state !== 'RESERVED') throw new DomainError('NOT_RESERVED');
      this.db.prepare("UPDATE reservations SET state='CONSUMED',version=version+1 WHERE tenant=? AND intent_key=?").run(r.tenantId, r.intentKey);
      this.effect(r, 'consume'); return this.inspect(r);
    });
  }
  private insert(r: BusinessRequest, state: InventoryState, applied: boolean): void {
    this.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,1)')
      .run(r.tenantId, r.intentKey, r.argsHash, r.warehouseId, r.sku, r.quantity, state, Number(applied), randomUUID());
  }
  private effect(r: BusinessRequest, kind: string): void {
    this.db.prepare('INSERT INTO effects VALUES(?,?,?,?)').run(r.tenantId, r.intentKey, kind, r.quantity);
  }
  stock(tenant: string, warehouse: string, sku: string): number {
    return Number(this.db.prepare('SELECT available FROM stock WHERE tenant=? AND warehouse=? AND sku=?').get(tenant, warehouse, sku)?.available ?? 0);
  }
  effectCount(key: string, kind: string): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM effects WHERE intent_key=? AND kind=?').get(key, kind)!.n);
  }
  snapshot() {
    return { stock: this.db.prepare('SELECT * FROM stock').all(), reservations: this.db.prepare('SELECT * FROM reservations').all(), effects: this.db.prepare('SELECT * FROM effects').all() };
  }
  armFault(name: string, intentKey: string, mode: 'drop' | 'hold'): void {
    this.db.prepare('INSERT INTO faults(name,intent_key,mode) VALUES(?,?,?)').run(name, intentKey, mode);
  }
  takeFault(name: string, key: string): 'drop' | 'hold' | undefined {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM faults WHERE name=? AND intent_key=? AND hits=0').get(name, key);
      if (!row) return undefined;
      this.db.prepare('UPDATE faults SET hits=1 WHERE name=?').run(name);
      return row.mode as 'drop' | 'hold';
    });
  }
  fault(name: string) { return this.db.prepare('SELECT * FROM faults WHERE name=?').get(name); }
  releaseFault(name: string): void { this.db.prepare('UPDATE faults SET released=1 WHERE name=?').run(name); }
  close(): void { this.db.close(); }
}
