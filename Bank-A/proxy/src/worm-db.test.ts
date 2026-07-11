import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initWormDb, putContentBlob } from "./worm-db.js";

const validBlob = {
  ciphertext: "aa",
  iv: "bb",
  tag: "cc",
  wrappedDeks: { "bank-a": { kek_kid: "bank-a-kek", wrapped_dek: "dd" } },
};

function freshPath(): string {
  return join(tmpdir(), `bank-a-worm-db-test-${randomUUID()}.db`);
}

describe("putContentBlob", () => {
  it("stores a new content-addressed blob (created: true)", () => {
    initWormDb(freshPath());
    const result = putContentBlob("hash-1", validBlob);
    expect(result.created).toBe(true);
  });

  it("is idempotent on a write-once replay of the same content", () => {
    initWormDb(freshPath());
    putContentBlob("hash-1", validBlob);
    const result = putContentBlob("hash-1", validBlob);
    expect(result.created).toBe(false);
  });

  it("throws when the same contentHash is written with different content", () => {
    initWormDb(freshPath());
    putContentBlob("hash-1", validBlob);
    expect(() => putContentBlob("hash-1", { ...validBlob, ciphertext: "different" })).toThrow();
  });
});
