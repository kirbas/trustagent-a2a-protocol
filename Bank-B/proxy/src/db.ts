import Database from "better-sqlite3";

let db: Database.Database;

export function initDb(path: string): void {
  db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS envelopes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_chain (
      sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      prev_hash TEXT,
      node_hash TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_budgets (
      entity_did TEXT PRIMARY KEY,
      max_limit REAL NOT NULL,
      current_spend REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS provenance (
      content_hash TEXT PRIMARY KEY,
      tx_id TEXT NOT NULL,
      receipt_sig TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export function saveEnvelope(
  id: string,
  type: string,
  traceId: string,
  rawPayload: unknown,
  signature: string
): void {
  db.prepare(
    "INSERT OR IGNORE INTO envelopes (id, type, trace_id, raw_payload, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, type, traceId, JSON.stringify(rawPayload), signature, new Date().toISOString());
}

export function getEnvelopes(): unknown[] {
  return db.prepare("SELECT * FROM envelopes ORDER BY created_at ASC").all();
}

export function clearEnvelopes(): void {
  db.exec("DELETE FROM envelopes");
}
