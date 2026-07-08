/**
 * Bank-A proxy — local WORM content store (Delta #5)
 *
 * Bank-A is the origin of the plaintext (it has `args`/`outputData` directly
 * from the `/invoke` call), so it is the party that builds the encrypted,
 * content-addressed record (see `buildWormRecord` in `@trustagentai/a2a-core`)
 * and is naturally one of the cross-held copies. This module just persists
 * that already-encrypted record locally — never plaintext, never a bare DEK —
 * with the same write-once invariant as the witness's blob store: a repeat
 * put for the same content hash is idempotent if byte-identical, rejected if
 * it differs.
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

export function initWormDb(path: string): void {
  db = new Database(path, { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_blobs (
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

export type BlobInput = Pick<StoredBlob, "ciphertext" | "iv" | "tag" | "wrappedDeks">;

export interface PutBlobResult {
  blob: StoredBlob;
  created: boolean;
}

/** Write-once put, identical invariant to the witness's blob-db.ts. */
export function putContentBlob(contentHash: string, blob: BlobInput): PutBlobResult {
  const existingRow = db.prepare("SELECT * FROM content_blobs WHERE content_hash = ?").get(contentHash) as any;
  if (existingRow) {
    const existing = toStoredBlob(existingRow);
    if (serializeContent(existing) === serializeContent(blob)) {
      return { blob: existing, created: false };
    }
    throw new Error(`WORM violation: blob ${contentHash} already stored with different content`);
  }

  db.prepare(
    "INSERT INTO content_blobs (content_hash, ciphertext, iv, tag, wrapped_deks, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(contentHash, blob.ciphertext, blob.iv, blob.tag, JSON.stringify(blob.wrappedDeks), new Date().toISOString());

  return { blob: { contentHash, ...blob }, created: true };
}

export function getContentBlob(contentHash: string): StoredBlob | undefined {
  const row = db.prepare("SELECT * FROM content_blobs WHERE content_hash = ?").get(contentHash) as any;
  return row ? toStoredBlob(row) : undefined;
}

export function clearContentBlobs(): void {
  db.exec("DELETE FROM content_blobs");
}
