/**
 * TrustAgentAI Cloud — WORM blob store (Delta #5)
 *
 * Persists content-addressed, encrypted blobs pushed by the banks: ciphertext
 * plus each holder's wrapped DEK. The witness NEVER receives plaintext or a
 * bare DEK — only what's needed to (a) serve the encrypted blob back to a
 * holder who can unwrap their own DEK, and (b) enforce write-once (see
 * `@trustagentai/a2a-core`'s `createBlobStore` for the shared CRUD/write-once
 * logic — this file just binds it to the witness's own DB file and table;
 * `Bank-A/proxy/src/worm-db.ts` is its twin for Bank-A's local copy).
 */

import Database from "better-sqlite3";
import { initBlobTable, createBlobStore, type BlobStore } from "@trustagentai/a2a-core";
export type { StoredBlob, BlobInput, PutBlobResult } from "@trustagentai/a2a-core";

const TABLE = "blobs";
let store: BlobStore;

export function initBlobDb(path: string): void {
  const db = new Database(path, { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  initBlobTable(db, TABLE);
  store = createBlobStore(db, TABLE);
}

export const putBlob: BlobStore["putBlob"] = (contentHash, blob) => store.putBlob(contentHash, blob);
export const getBlob: BlobStore["getBlob"] = (contentHash) => store.getBlob(contentHash);
export const clearBlobs: BlobStore["clearBlobs"] = () => store.clearBlobs();
