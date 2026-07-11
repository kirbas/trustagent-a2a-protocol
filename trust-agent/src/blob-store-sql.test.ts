import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initBlobTable, createBlobStore } from "./blob-store-sql.js";

const sampleBlob = {
  ciphertext: "aa",
  iv: "bb",
  tag: "cc",
  wrappedDeks: { witness: { iv: "1", ciphertext: "2", tag: "3" } },
};

function freshStore(tableName = "blobs") {
  const db = new Database(":memory:");
  initBlobTable(db, tableName);
  return createBlobStore(db, tableName);
}

describe("createBlobStore (shared WORM blob CRUD)", () => {
  it("stores a new blob and reports it as created", () => {
    const store = freshStore();
    const { blob, created } = store.putBlob("hash-1", sampleBlob);
    expect(created).toBe(true);
    expect(blob.contentHash).toBe("hash-1");
    expect(store.getBlob("hash-1")).toEqual(blob);
  });

  it("is idempotent when the same id is re-put with identical content", () => {
    const store = freshStore();
    store.putBlob("hash-1", sampleBlob);
    const { created } = store.putBlob("hash-1", sampleBlob);
    expect(created).toBe(false);
  });

  it("rejects a re-put of the same id with different content", () => {
    const store = freshStore();
    store.putBlob("hash-1", sampleBlob);
    expect(() => store.putBlob("hash-1", { ...sampleBlob, ciphertext: "different" })).toThrow();
  });

  it("returns undefined for a content hash that was never stored", () => {
    expect(freshStore().getBlob("missing")).toBeUndefined();
  });

  it("clearBlobs empties the table", () => {
    const store = freshStore();
    store.putBlob("hash-1", sampleBlob);
    store.clearBlobs();
    expect(store.getBlob("hash-1")).toBeUndefined();
  });

  it("works against a custom table name, independently of other tables", () => {
    const db = new Database(":memory:");
    initBlobTable(db, "blobs");
    initBlobTable(db, "content_blobs");
    const witnessStore = createBlobStore(db, "blobs");
    const bankStore = createBlobStore(db, "content_blobs");

    witnessStore.putBlob("hash-1", sampleBlob);
    expect(bankStore.getBlob("hash-1")).toBeUndefined(); // separate tables, no cross-talk
  });
});
