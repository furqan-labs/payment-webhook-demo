import Database from 'better-sqlite3';

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'failed' | 'amount_mismatch';

export interface Order {
  id: string;
  sku: string;
  quantity: number;
  amount: number; // total in the smallest currency unit (cents)
  currency: string;
  status: OrderStatus;
  sessionId: string | null;
  createdAt: string;
  paidAt: string | null;
}

interface OrderRow {
  id: string;
  sku: string;
  quantity: number;
  amount: number;
  currency: string;
  status: OrderStatus;
  session_id: string | null;
  created_at: string;
  paid_at: string | null;
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    sku: row.sku,
    quantity: row.quantity,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    sessionId: row.session_id,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

export class OrderStore {
  private db: Database.Database;

  constructor(path: string = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        paid_at TEXT
      );
      -- Every webhook event id we have already handled. Stripe can deliver
      -- the same event more than once, so this is what makes handling idempotent.
      CREATE TABLE IF NOT EXISTS processed_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `);
  }

  createOrder(input: { id: string; sku: string; quantity: number; amount: number; currency: string }): Order {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO orders (id, sku, quantity, amount, currency, status, created_at)
         VALUES (@id, @sku, @quantity, @amount, @currency, 'pending', @createdAt)`
      )
      .run({ ...input, createdAt });
    return this.getOrder(input.id)!;
  }

  getOrder(id: string): Order | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
    return row ? toOrder(row) : null;
  }

  attachSession(orderId: string, sessionId: string): void {
    this.db.prepare('UPDATE orders SET session_id = ? WHERE id = ?').run(sessionId, orderId);
  }

  /**
   * Moves an order to a new status. "paid" is final: once an order is paid, no
   * later event can change its status or overwrite its payment time.
   * Returns true if the order was actually updated.
   */
  setStatus(orderId: string, status: OrderStatus): boolean {
    const result = this.db
      .prepare(
        `UPDATE orders
         SET status = @status,
             paid_at = CASE WHEN @status = 'paid' THEN @now ELSE paid_at END
         WHERE id = @id AND status != 'paid'`
      )
      .run({ id: orderId, status, now: new Date().toISOString() });
    return result.changes === 1;
  }

  /**
   * Records a webhook event id. Returns true the first time the id is seen and
   * false for every later delivery of the same event. The PRIMARY KEY makes the
   * check-and-insert atomic, so two concurrent deliveries cannot both win.
   */
  recordEvent(eventId: string, type: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO processed_events (id, type, received_at) VALUES (?, ?, ?)')
      .run(eventId, type, new Date().toISOString());
    return result.changes === 1;
  }

  /** Runs fn inside one SQLite transaction: if it throws, every write inside it is rolled back. */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
