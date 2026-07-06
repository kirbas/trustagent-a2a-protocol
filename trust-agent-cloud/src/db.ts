/**
 * TrustAgentAI Cloud — witness co-sign hash-chain (Delta #3)
 *
 * The witness owns its own SQLite database, independent of both banks and of
 * their key-encryption-keys. Every co-signature is persisted as one row in an
 * append-only chain built on the SHARED hash-chain module (`hash-chain.ts`,
 * Delta #2): each row carries a monotonic `seq` and a `prev_hash` linking it to
 * the prior row's content hash. Deleting a row leaves a `seq` gap; editing a
 * row breaks its successor's `prev_hash`. This makes the witness itself
 * verifiable — even it cannot silently rewrite history.
 */

import Database from "better-sqlite3";
import {
  GENESIS_PREV_HASH,
  computeRowHash,
  verifyChain,
  type ChainRow,
  type ChainVerifyResult,
  type CoSignReceipt,
} from "@trustagentai/a2a-core";

let db: Database.Database;

/** A co-sign row rehydrated for callers: the receipt plus its chain position. */
export interface StoredCoSign {
  receipt: CoSignReceipt;
  seq: number;
  prev_hash: string;
}

export function initDb(path: string): void {
  db = new Database(path, { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cosigns (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER,
      prev_hash TEXT
    );
  `);
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

/** Deterministic row id for a trace's single co-signature (idempotency key). */
function rowId(traceId: string): string {
  return `${traceId}:cosign`;
}

/**
 * Append a co-sign receipt to the chain, atomically. Idempotent on `trace_id`:
 * a second call for the same transaction is a no-op that returns the existing
 * chain position rather than forking or advancing the chain.
 */
export function appendCoSign(
  traceId: string,
  receipt: CoSignReceipt
): { seq: number; prev_hash: string; created: boolean } {
  const id = rowId(traceId);
  const now = new Date().toISOString();
  const payload = JSON.stringify(receipt);
  const signature = JSON.stringify(receipt.signatures);

  const append = db.transaction(() => {
    const existing = db.prepare("SELECT seq, prev_hash FROM cosigns WHERE id = ?").get(id) as
      | { seq: number; prev_hash: string }
      | undefined;
    if (existing) {
      return { seq: existing.seq, prev_hash: existing.prev_hash, created: false };
    }
    const head = db.prepare("SELECT * FROM cosigns ORDER BY seq DESC LIMIT 1").get() as any;
    const seq = head ? head.seq + 1 : 0;
    const prevHash = head ? computeRowHash(toChainRow(head)) : GENESIS_PREV_HASH;
    db.prepare(
      "INSERT INTO cosigns (id, type, trace_id, raw_payload, signature, created_at, seq, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, "COSIGN", traceId, payload, signature, now, seq, prevHash);
    return { seq, prev_hash: prevHash, created: true };
  });

  return append();
}

/** Look up the co-sign already recorded for a trace, if any. */
export function getCoSignByTrace(traceId: string): StoredCoSign | null {
  const row = db.prepare("SELECT * FROM cosigns WHERE id = ?").get(rowId(traceId)) as any;
  if (!row) return null;
  return {
    receipt: JSON.parse(row.raw_payload) as CoSignReceipt,
    seq: row.seq,
    prev_hash: row.prev_hash,
  };
}

/** All co-sign rows as an ordered chain (seq ascending). */
export function getCoSignChain(): ChainRow[] {
  return (db.prepare("SELECT * FROM cosigns ORDER BY seq ASC").all() as any[]).map(toChainRow);
}

/** Verify the witness chain: no seq gaps, prev_hash links intact. */
export function verifyCoSignChain(): ChainVerifyResult {
  return verifyChain(getCoSignChain());
}

/** Drop all co-sign rows (demo /reset and tests). */
export function clearCoSigns(): void {
  db.exec("DELETE FROM cosigns");
}
