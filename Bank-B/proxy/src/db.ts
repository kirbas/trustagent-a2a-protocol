import Database from "better-sqlite3";

let db: Database.Database;

export function initDb(path: string): void {
  db = new Database(path, { timeout: 5000 });
  db.exec(`
    CREATE TABLE IF NOT EXISTS envelopes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL
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

export function clearEnvelopes(): void {
  db.exec("DELETE FROM envelopes");
  db.exec("DELETE FROM anchors");
  db.exec("DELETE FROM anchor_leaves");
}
