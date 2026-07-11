/**
 * Bank-A proxy — local WORM content store (Delta #5)
 *
 * Bank-A is the origin of the plaintext (it has `args`/`outputData` directly
 * from the `/invoke` call), so it is the party that builds the encrypted,
 * content-addressed record (see `buildWormRecord` in `@trustagentai/a2a-core`)
 * and is naturally one of the cross-held copies. This module persists that
 * already-encrypted record locally — never plaintext, never a bare DEK —
 * using the shared write-once CRUD from `@trustagentai/a2a-core`'s
 * `createBlobStore` (`trust-agent-cloud/src/blob-db.ts` is its twin for the
 * witness's own copy).
 */

import Database from "better-sqlite3";
import { initBlobTable, createBlobStore, type BlobStore } from "@trustagentai/a2a-core";

const TABLE = "content_blobs";
let store: BlobStore;

export function initWormDb(path: string): void {
  const db = new Database(path, { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  initBlobTable(db, TABLE);
  store = createBlobStore(db, TABLE);
}

export const putContentBlob: BlobStore["putBlob"] = (contentHash, blob) => store.putBlob(contentHash, blob);
