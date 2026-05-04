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

export function getRecentEnvelopeData(limit: number): Array<{ id: string; signature: string }> {
  return db.prepare(
    "SELECT id, signature FROM envelopes ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as Array<{ id: string; signature: string }>;
}

export function saveProvenance(contentHash: string, txId: string, receiptSig: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO provenance (content_hash, tx_id, receipt_sig, created_at) VALUES (?, ?, ?, ?)"
  ).run(contentHash, txId, receiptSig, new Date().toISOString());
}

export function saveAnchor(anchor: {
  batchId: string;
  merkleRoot: string;
  txHash?: string;
  blockNumber?: number;
  status: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO anchors (batch_id, merkle_root, tx_hash, block_number, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    anchor.batchId,
    anchor.merkleRoot,
    anchor.txHash ?? null,
    anchor.blockNumber ?? null,
    anchor.status,
    new Date().toISOString()
  );
}

export function saveAnchorLeaves(
  batchId: string,
  leaves: Array<{ leafIndex: number; envelopeId: string; leafHash: string; proofPath: string }>
): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO anchor_leaves (batch_id, leaf_index, envelope_id, leaf_hash, proof_path) VALUES (?, ?, ?, ?, ?)"
  );
  for (const leaf of leaves) {
    stmt.run(batchId, leaf.leafIndex, leaf.envelopeId, leaf.leafHash, leaf.proofPath);
  }
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

export function clearEnvelopes(): void {
  db.exec("DELETE FROM envelopes");
  db.exec("DELETE FROM provenance");
  db.exec("DELETE FROM anchors");
  db.exec("DELETE FROM anchor_leaves");
}
