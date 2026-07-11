import { describe, it, expect, vi, afterEach } from "vitest";
import { NonceRegistry } from "./nonce-registry.js";

const DID = "did:workload:agent#key-1";

describe("NonceRegistry.consume", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true for a fresh nonce (first use)", () => {
    const registry = new NonceRegistry();
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    expect(registry.consume(DID, "nonce-1", expiresAt)).toBe(true);
  });

  it("returns false when the same (did, nonce) is replayed", () => {
    const registry = new NonceRegistry();
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    registry.consume(DID, "nonce-1", expiresAt);
    expect(registry.consume(DID, "nonce-1", expiresAt)).toBe(false);
  });

  it("treats the same nonce as fresh for a different initiator", () => {
    const registry = new NonceRegistry();
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    registry.consume(DID, "nonce-1", expiresAt);
    expect(registry.consume("did:workload:other#key-1", "nonce-1", expiresAt)).toBe(true);
  });

  it("purges expired entries so a new nonce can reuse the slot after expiry", () => {
    vi.useFakeTimers();
    const registry = new NonceRegistry();
    const now = Date.now();
    vi.setSystemTime(now);
    const expiresAt = new Date(now + 1_000).toISOString(); // +1s, skew tolerance is 5s

    registry.consume(DID, "nonce-1", expiresAt);
    expect(registry.size()).toBe(1);

    // Advance past expires_at + skew tolerance (5s)
    vi.setSystemTime(now + 1_000 + 5_000 + 1);
    // Consuming a different nonce triggers the lazy purge
    registry.consume(DID, "nonce-2", new Date(now + 1_000 + 5_000 + 30_000).toISOString());
    expect(registry.size()).toBe(1); // nonce-1 purged, nonce-2 present
  });
});

describe("NonceRegistry.checkExpiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when now is before expires_at", () => {
    const registry = new NonceRegistry();
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    expect(registry.checkExpiry(expiresAt)).toBe(true);
  });

  it("returns true when now is within the skew tolerance window past expires_at", () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const registry = new NonceRegistry();
    const expiresAt = new Date(now - 1_000).toISOString(); // already expired by 1s
    expect(registry.checkExpiry(expiresAt)).toBe(true); // within 5s skew tolerance
  });

  it("returns false once past expires_at + skew tolerance", () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const registry = new NonceRegistry();
    const expiresAt = new Date(now - 5_001).toISOString(); // past 5s skew tolerance
    expect(registry.checkExpiry(expiresAt)).toBe(false);
  });
});

describe("NonceRegistry.size", () => {
  it("reflects the number of tracked (did, nonce) entries", () => {
    const registry = new NonceRegistry();
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    expect(registry.size()).toBe(0);
    registry.consume(DID, "nonce-1", expiresAt);
    registry.consume(DID, "nonce-2", expiresAt);
    expect(registry.size()).toBe(2);
  });
});
