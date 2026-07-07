import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initBlobDb, putBlob, getBlob, clearBlobs } from "./blob-db.js";

const sampleBlob = {
  ciphertext: "aa",
  iv: "bb",
  tag: "cc",
  wrappedDeks: { witness: { iv: "1", ciphertext: "2", tag: "3" } },
};

beforeEach(() => {
  initBlobDb(join(tmpdir(), `blob-db-test-${randomUUID()}.db`));
  clearBlobs();
});

describe("putBlob / getBlob (WORM)", () => {
  it("stores a new blob and reports it as created", () => {
    const { blob, created } = putBlob("hash-1", sampleBlob);
    expect(created).toBe(true);
    expect(blob.contentHash).toBe("hash-1");
    expect(getBlob("hash-1")).toEqual(blob);
  });

  it("is idempotent when the same id is re-put with identical content", () => {
    putBlob("hash-1", sampleBlob);
    const { created } = putBlob("hash-1", sampleBlob);
    expect(created).toBe(false);
  });

  it("rejects a re-put of the same id with different content", () => {
    putBlob("hash-1", sampleBlob);
    expect(() => putBlob("hash-1", { ...sampleBlob, ciphertext: "different" })).toThrow();
  });

  it("returns undefined for a content hash that was never stored", () => {
    expect(getBlob("missing")).toBeUndefined();
  });
});
