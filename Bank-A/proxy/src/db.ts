import Database from "better-sqlite3";

let db: Database.Database;
let sseBus: any = null;

export function setSseBus(bus: any): void {
  sseBus = bus;
}

export function initDb(path: string): void {
  db = new Database(path, { timeout: 5000 });
  // WAL mode for high-concurrency reads/writes without locking
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS envelopes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provenance (
      content_hash TEXT PRIMARY KEY,
      tx_id TEXT NOT NULL,
      receipt_sig TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thoughts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      text TEXT NOT NULL,
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
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO envelopes (id, type, trace_id, raw_payload, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, type, traceId, JSON.stringify(rawPayload), signature, now);
  
  // Concurrent SSE broadcast
  sseBus?.broadcast("envelope", { id, type, trace_id: traceId, created_at: now });
  
  // Phase transition trigger
  if (type === "INTENT") {
    sseBus?.broadcast("system-phase", { phase: "RUNNING" });
  }
}

export function getEnvelopes(): unknown[] {
  return db.prepare("SELECT * FROM envelopes ORDER BY created_at ASC").all();
}

export function saveProvenance(contentHash: string, txId: string, receiptSig: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO provenance (content_hash, tx_id, receipt_sig, created_at) VALUES (?, ?, ?, ?)"
  ).run(contentHash, txId, receiptSig, new Date().toISOString());
}

export function getEnvelopesByTraceId(traceId: string): unknown[] {
  return db.prepare("SELECT * FROM envelopes WHERE trace_id = ? ORDER BY created_at ASC").all(traceId);
}

export function clearEnvelopes(): void {
  db.exec("DELETE FROM envelopes");
  db.exec("DELETE FROM provenance");
  db.exec("DELETE FROM thoughts");
}

export function saveThought(source: string, text: string): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO thoughts (source, text, created_at) VALUES (?, ?, ?)")
    .run(source, text, now);
  
  // Concurrent SSE broadcast for real-time UI
  sseBus?.broadcast("thought", { source, text, ts: now });
}

export function getThoughts(): any[] {
  return db.prepare("SELECT * FROM thoughts ORDER BY created_at ASC").all();
}
