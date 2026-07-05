import Database from "better-sqlite3";
import {
  GENESIS_PREV_HASH,
  computeRowHash,
  verifyChain,
  type ChainRow,
  type ChainVerifyResult,
} from "@trustagentai/a2a-core";

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
      created_at TEXT NOT NULL,
      seq INTEGER,
      prev_hash TEXT
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

  backfillChain();
}

/** Map a raw DB row to the shared ChainRow shape (field names already align). */
function toChainRow(r: any): ChainRow {
  return {
    seq: r.seq,
    prev_hash: r.prev_hash,
    id: r.id,
    type: r.type,
    trace_id: r.trace_id,
    raw_payload: r.raw_payload,
    signature: r.signature,
    created_at: r.created_at,
  };
}

/**
 * Assign seq + prev_hash to any pre-existing rows that predate Delta #2
 * (columns added but still NULL). Links them in created_at order so the
 * historical record becomes a verifiable chain. Idempotent: a no-op once
 * every row is linked.
 */
function backfillChain(): void {
  const pending = db
    .prepare("SELECT * FROM envelopes WHERE seq IS NULL ORDER BY created_at ASC")
    .all() as any[];
  if (pending.length === 0) return;

  const linked = db.prepare("SELECT * FROM envelopes WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1").get() as any;
  let seq = linked ? linked.seq + 1 : 0;
  let prevHash = linked ? computeRowHash(toChainRow(linked)) : GENESIS_PREV_HASH;

  const update = db.prepare("UPDATE envelopes SET seq = ?, prev_hash = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const r of pending) {
      const row: ChainRow = { ...toChainRow(r), seq, prev_hash: prevHash };
      update.run(seq, prevHash, r.id);
      prevHash = computeRowHash(row);
      seq += 1;
    }
  });
  tx();
}

export function saveEnvelope(
  id: string,
  type: string,
  traceId: string,
  rawPayload: unknown,
  signature: string
): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify(rawPayload);

  // Append to the hash-chain atomically: a duplicate id is a no-op and must
  // not advance the chain (no gap, no re-link).
  const append = db.transaction(() => {
    const exists = db.prepare("SELECT 1 FROM envelopes WHERE id = ?").get(id);
    if (exists) return;
    const head = db.prepare("SELECT * FROM envelopes ORDER BY seq DESC LIMIT 1").get() as any;
    const seq = head ? head.seq + 1 : 0;
    const prevHash = head ? computeRowHash(toChainRow(head)) : GENESIS_PREV_HASH;
    db.prepare(
      "INSERT INTO envelopes (id, type, trace_id, raw_payload, signature, created_at, seq, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, type, traceId, payload, signature, now, seq, prevHash);
  });
  append();

  // Concurrent SSE broadcast
  sseBus?.broadcast("envelope", { id, type, trace_id: traceId, created_at: now });

  // Phase transition trigger
  if (type === "INTENT") {
    sseBus?.broadcast("system-phase", { phase: "RUNNING" });
  }
}

/** All envelope rows as an ordered chain (seq ascending). */
export function getChain(): ChainRow[] {
  return (db
    .prepare("SELECT * FROM envelopes ORDER BY seq ASC")
    .all() as any[]).map(toChainRow);
}

/** Verify the local envelope hash-chain: no seq gaps, prev_hash links intact. */
export function verifyEnvelopeChain(): ChainVerifyResult {
  return verifyChain(getChain());
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
