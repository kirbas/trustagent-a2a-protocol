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
    CREATE TABLE IF NOT EXISTS anchors (
      batch_id TEXT PRIMARY KEY,
      merkle_root TEXT NOT NULL,
      tx_hash TEXT,
      block_number INTEGER,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS anchor_leaves (
      batch_id TEXT NOT NULL,
      leaf_index INTEGER NOT NULL,
      envelope_id TEXT NOT NULL,
      leaf_hash TEXT NOT NULL,
      proof_path TEXT NOT NULL,
      PRIMARY KEY (batch_id, leaf_index)
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

  sseBus?.broadcast("envelope", { id, type, trace_id: traceId, created_at: now });

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

export function getEnvelopesByTraceId(traceId: string): unknown[] {
  return db.prepare("SELECT * FROM envelopes WHERE trace_id = ? ORDER BY created_at ASC").all(traceId);
}

export interface AnchorRow {
  batch_id: string;
  merkle_root: string;
  tx_hash: string | null;
  block_number: number | null;
  status: string;
  created_at: string;
}

export interface AnchorLeafRow {
  leaf_index: number;
  envelope_id: string;
  leaf_hash: string;
  proof_path: string;
  envelope_type: string | null;
  trace_id: string | null;
}

export function getAnchorByTxHash(txHash: string): AnchorRow | null {
  return db.prepare("SELECT * FROM anchors WHERE tx_hash = ?").get(txHash) as AnchorRow | null;
}

export function getAnchorByTraceId(traceId: string): AnchorRow | null {
  const leaf = db.prepare(`
    SELECT al.batch_id
    FROM anchor_leaves al
    JOIN envelopes e ON e.id = al.envelope_id
    WHERE e.trace_id = ?
    LIMIT 1
  `).get(traceId) as { batch_id: string } | undefined;
  
  if (!leaf) return null;
  return db.prepare("SELECT * FROM anchors WHERE batch_id = ?").get(leaf.batch_id) as AnchorRow | null;
}

export function getAnchorLeaves(batchId: string): AnchorLeafRow[] {
  return db.prepare(`
    SELECT al.leaf_index, al.envelope_id, al.leaf_hash, al.proof_path,
           e.type AS envelope_type, e.trace_id
    FROM anchor_leaves al
    LEFT JOIN envelopes e ON e.id = al.envelope_id
    WHERE al.batch_id = ?
    ORDER BY al.leaf_index ASC
  `).all(batchId) as AnchorLeafRow[];
}

export function getDisputePackByTraceId(traceId: string) {
  const envelopes = db.prepare("SELECT * FROM envelopes WHERE trace_id = ? ORDER BY created_at ASC").all(traceId) as any[];
  const inclusionProofs = [];

  for (const env of envelopes) {
    const leaf = db.prepare(`
      SELECT al.*, a.merkle_root, a.tx_hash, a.block_number, a.created_at AS anchored_at
      FROM anchor_leaves al
      JOIN anchors a ON a.batch_id = al.batch_id
      WHERE al.envelope_id = ?
      LIMIT 1
    `).get(env.id) as any;

    if (leaf) {
      inclusionProofs.push({
        entry_hash: leaf.leaf_hash,
        proof: JSON.parse(leaf.proof_path),
        batch: {
          batch_id: leaf.batch_id,
          merkle_root: leaf.merkle_root,
          anchored_at: leaf.tx_hash,
          created_at: leaf.anchored_at
        }
      });
    }
  }

  return {
    records: envelopes.map(e => ({
      trace_id: e.trace_id,
      event_type: e.type + "_RECORD",
      entry_hash: e.id,
      timestamp: e.created_at
    })),
    entries: envelopes.map(e => ({
      trace_id: e.trace_id,
      event_type: e.type + "_RECORD",
      artifact: JSON.parse(e.raw_payload),
      entry_hash: e.id
    })),
    inclusionProofs
  };
}

export function getAnchors(): AnchorRow[] {
  return db.prepare("SELECT * FROM anchors ORDER BY created_at ASC").all() as AnchorRow[];
}

export function clearEnvelopes(): void {
  db.exec("DELETE FROM envelopes");
  db.exec("DELETE FROM anchors");
  db.exec("DELETE FROM anchor_leaves");
  db.exec("DELETE FROM thoughts");
}

export function saveThought(source: string, text: string): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO thoughts (source, text, created_at) VALUES (?, ?, ?)")
    .run(source, text, now);
  
  sseBus?.broadcast("thought", { source, text, ts: now });
}

export function getThoughts(): any[] {
  return db.prepare("SELECT * FROM thoughts ORDER BY created_at ASC").all();
}
