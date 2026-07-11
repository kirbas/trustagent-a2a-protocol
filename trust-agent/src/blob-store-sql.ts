/**
 * TrustAgentAI — shared WORM blob-store SQL (DRY refactor)
 *
 * The witness's blob store (Delta #5, `trust-agent-cloud/src/blob-db.ts`) and
 * Bank-A's local content store (`Bank-A/proxy/src/worm-db.ts`) persisted
 * byte-for-byte the same write-once CRUD logic against their own SQLite
 * table. This module is that logic, factored out once. It takes a minimal
 * structural `SqlDatabase` interface (not the `better-sqlite3` package
 * itself) so `@trustagentai/a2a-core` stays storage-agnostic — each service
 * still owns its own `Database` instance, file path, and table name.
 */

import type { WrappedKey } from "./worm.js";

/** The minimal subset of `better-sqlite3`'s API this module needs. */
export interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): any;
    run(...params: unknown[]): unknown;
  };
}

export interface StoredBlob {
  contentHash: string;
  ciphertext: string;
  iv: string;
  tag: string;
  wrappedDeks: Record<string, WrappedKey>;
}

export type BlobInput = Pick<StoredBlob, "ciphertext" | "iv" | "tag" | "wrappedDeks">;

export interface PutBlobResult {
  blob: StoredBlob;
  created: boolean;
}

const TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertValidTableName(tableName: string): void {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(`invalid table name: ${tableName}`);
  }
}

/** Create the WORM blobs table (idempotent) under `tableName`. */
export function initBlobTable(db: SqlDatabase, tableName: string): void {
  assertValidTableName(tableName);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
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

export interface BlobStore {
  /**
   * Write-once put: a first write for `contentHash` inserts the row; a
   * repeat write with byte-identical content is a no-op; a repeat write
   * with any difference throws (WORM violation).
   */
  putBlob(contentHash: string, blob: BlobInput): PutBlobResult;
  getBlob(contentHash: string): StoredBlob | undefined;
  /** Drop all rows (demo /reset and tests). */
  clearBlobs(): void;
}

/**
 * Bind the write-once WORM blob CRUD to one table on a given SQL connection.
 * Used identically by the witness's blob store and each proxy's local
 * content store — only the physical DB file and table name differ.
 */
export function createBlobStore(db: SqlDatabase, tableName: string): BlobStore {
  assertValidTableName(tableName);

  return {
    putBlob(contentHash: string, blob: BlobInput): PutBlobResult {
      const existingRow = db.prepare(`SELECT * FROM ${tableName} WHERE content_hash = ?`).get(contentHash);
      if (existingRow) {
        const existing = toStoredBlob(existingRow);
        if (serializeContent(existing) === serializeContent(blob)) {
          return { blob: existing, created: false };
        }
        throw new Error(`WORM violation: blob ${contentHash} already stored with different content`);
      }

      db.prepare(
        `INSERT INTO ${tableName} (content_hash, ciphertext, iv, tag, wrapped_deks, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(contentHash, blob.ciphertext, blob.iv, blob.tag, JSON.stringify(blob.wrappedDeks), new Date().toISOString());

      return { blob: { contentHash, ...blob }, created: true };
    },

    getBlob(contentHash: string): StoredBlob | undefined {
      const row = db.prepare(`SELECT * FROM ${tableName} WHERE content_hash = ?`).get(contentHash);
      return row ? toStoredBlob(row) : undefined;
    },

    clearBlobs(): void {
      db.exec(`DELETE FROM ${tableName}`);
    },
  };
}
