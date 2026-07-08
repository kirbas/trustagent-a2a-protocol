/**
 * TrustAgentAI Cloud — WORM blob store (Delta #5)
 *
 * Persists content-addressed, encrypted blobs pushed by the banks: ciphertext
 * plus each holder's wrapped DEK. The witness NEVER receives plaintext or a
 * bare DEK — only what's needed to (a) serve the encrypted blob back to a
 * holder who can unwrap their own DEK, and (b) enforce write-once: a repeat
 * PUT for the same content hash is idempotent if byte-identical, and rejected
 * if the content differs (see `@trustagentai/a2a-core`'s `WormBlobStore` for
 * the same invariant applied in-memory; this is its SQLite-backed twin so the
 * witness's blob store survives restarts like its cosign chain does).
 */

import Database from "better-sqlite3";

let db: Database.Database;

interface WrappedDek {
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface StoredBlob {
  contentHash: string;
  ciphertext: string;
  iv: string;
  tag: string;
  wrappedDeks: Record<string, WrappedDek>;
}

export function initBlobDb(path: string): void {
  db = new Database(path, { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      content_hash TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      wrapped_deks TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function toStoredBlob(r: any): StoredBlob {
  return {
    contentHash: r.content_hash,
    ciphertext: r.ciphertext,
    iv: r.iv,
    tag: r.tag,
    wrappedDeks: JSON.parse(r.wrapped_deks),
  };
}

function serializeContent(b: Pick<StoredBlob, "ciphertext" | "iv" | "tag" | "wrappedDeks">): string {
  return JSON.stringify({ ciphertext: b.ciphertext, iv: b.iv, tag: b.tag, wrappedDeks: b.wrappedDeks });
}

export interface PutBlobResult {
  blob: StoredBlob;
  created: boolean;
}

export type BlobInput = Pick<StoredBlob, "ciphertext" | "iv" | "tag" | "wrappedDeks">;

/**
 * Write-once put: a first write for `contentHash` inserts the row; a repeat
 * write with byte-identical ciphertext/iv/tag/wrappedDeks is a no-op; a
 * repeat write with any difference throws (WORM violation).
 */
export function putBlob(contentHash: string, blob: BlobInput): PutBlobResult {
  const existingRow = db.prepare("SELECT * FROM blobs WHERE content_hash = ?").get(contentHash) as any;
  if (existingRow) {
    const existing = toStoredBlob(existingRow);
    if (serializeContent(existing) === serializeContent(blob)) {
      return { blob: existing, created: false };
    }
    throw new Error(`WORM violation: blob ${contentHash} already stored with different content`);
  }

  db.prepare(
    "INSERT INTO blobs (content_hash, ciphertext, iv, tag, wrapped_deks, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(contentHash, blob.ciphertext, blob.iv, blob.tag, JSON.stringify(blob.wrappedDeks), new Date().toISOString());

  return { blob: { contentHash, ...blob }, created: true };
}

export function getBlob(contentHash: string): StoredBlob | undefined {
  const row = db.prepare("SELECT * FROM blobs WHERE content_hash = ?").get(contentHash) as any;
  return row ? toStoredBlob(row) : undefined;
}

/** Drop all blob rows (demo /reset and tests). */
export function clearBlobs(): void {
  db.exec("DELETE FROM blobs");
}
