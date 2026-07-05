import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadOrCreateKeyPair,
  generateKeyPair,
  computeEnvelopeHash,
  sha256Json,
  sha256,
  signEnvelope,
  verifySignature,
  generateNonce,
} from "./crypto.js";

const KID = "did:workload:test-proxy#key-1";
const KEK = "0".repeat(64); // 32-byte hex KEK

describe("loadOrCreateKeyPair", () => {
  let dir: string;
  let keystorePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystore-test-"));
    keystorePath = join(dir, "keystore.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a keystore file when none exists", async () => {
    const keyPair = await loadOrCreateKeyPair(KID, keystorePath, KEK);
    expect(keyPair.kid).toBe(KID);
    expect(keyPair.publicKey.length).toBe(32);
    expect(keyPair.privateKey.length).toBe(32);

    const raw = JSON.parse(readFileSync(keystorePath, "utf8"));
    expect(raw.kid).toBe(KID);
    expect(raw.publicKey).toBe(Buffer.from(keyPair.publicKey).toString("hex"));
    expect(raw.iv).toBeTypeOf("string");
    expect(raw.ciphertext).toBeTypeOf("string");
    expect(raw.tag).toBeTypeOf("string");
    // private key bytes must never appear in plaintext anywhere in the file
    const privHex = Buffer.from(keyPair.privateKey).toString("hex");
    expect(raw.ciphertext).not.toBe(privHex);
  });

  it("returns the same public key across reloads (survives restart)", async () => {
    const first = await loadOrCreateKeyPair(KID, keystorePath, KEK);
    const second = await loadOrCreateKeyPair(KID, keystorePath, KEK);
    expect(Buffer.from(second.publicKey).toString("hex")).toBe(
      Buffer.from(first.publicKey).toString("hex")
    );
    expect(Buffer.from(second.privateKey).toString("hex")).toBe(
      Buffer.from(first.privateKey).toString("hex")
    );
  });

  it("throws GCM auth failure when ciphertext is tampered", async () => {
    await loadOrCreateKeyPair(KID, keystorePath, KEK);
    const raw = JSON.parse(readFileSync(keystorePath, "utf8"));
    const tamperedByte = ((parseInt(raw.ciphertext.slice(0, 2), 16) ^ 0xff) & 0xff)
      .toString(16)
      .padStart(2, "0");
    raw.ciphertext = tamperedByte + raw.ciphertext.slice(2);
    writeFileSync(keystorePath, JSON.stringify(raw));

    await expect(loadOrCreateKeyPair(KID, keystorePath, KEK)).rejects.toThrow();
  });

  it("throws (does not silently mint a new key) when KEK is wrong", async () => {
    await loadOrCreateKeyPair(KID, keystorePath, KEK);
    const wrongKek = "f".repeat(64);
    await expect(
      loadOrCreateKeyPair(KID, keystorePath, wrongKek)
    ).rejects.toThrow();
  });

  it("rejects a KEK that is not 32 bytes of hex", async () => {
    await expect(
      loadOrCreateKeyPair(KID, keystorePath, "too-short")
    ).rejects.toThrow();
  });
});

describe("envelope hashing and signing", () => {
  it("computeEnvelopeHash excludes signatures and entry_hash", () => {
    const envelope = { a: 1, signatures: ["x"], entry_hash: "y" };
    const withoutExtras = computeEnvelopeHash({ a: 1 });
    expect(computeEnvelopeHash(envelope)).toBe(withoutExtras);
  });

  it("sha256Json and sha256 are stable and deterministic", () => {
    expect(sha256Json({ a: 1 })).toBe(sha256Json({ a: 1 }));
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256Json({ a: 1 })).not.toBe(sha256Json({ a: 2 }));
  });

  it("signEnvelope produces a signature verifySignature accepts", async () => {
    const keyPair = await generateKeyPair("did:workload:signer#key-1");
    const envelope = { foo: "bar" };
    const sig = await signEnvelope(envelope, keyPair, "proxy");
    expect(sig.kid).toBe(keyPair.kid);
    await expect(
      verifySignature(envelope, sig, keyPair.publicKey)
    ).resolves.toBeUndefined();
  });

  it("verifySignature rejects a tampered envelope", async () => {
    const keyPair = await generateKeyPair("did:workload:signer#key-1");
    const sig = await signEnvelope({ foo: "bar" }, keyPair, "proxy");
    await expect(
      verifySignature({ foo: "tampered" }, sig, keyPair.publicKey)
    ).rejects.toThrow();
  });

  it("verifySignature rejects a signature from the wrong key", async () => {
    const signer = await generateKeyPair("did:workload:signer#key-1");
    const other = await generateKeyPair("did:workload:other#key-1");
    const envelope = { foo: "bar" };
    const sig = await signEnvelope(envelope, signer, "proxy");
    await expect(
      verifySignature(envelope, sig, other.publicKey)
    ).rejects.toThrow();
  });

  it("generateNonce returns 16 hex chars (8 random bytes)", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
