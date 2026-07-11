import { describe, it, expect } from "vitest";
import { generateKeyPair, signEnvelope } from "./crypto.js";
import type { KeyPair, SignatureBlock } from "./crypto.js";
import { KeyRegistry, buildRotationAttestation, didFromKid } from "./key-registry.js";

const DID = "did:workload:bank-a-proxy";

async function endorse(priorKey: KeyPair, did: string, newKid: string, newPublicKeyHex: string, now: string): Promise<SignatureBlock> {
  const attestation = buildRotationAttestation(did, newKid, newPublicKeyHex, now);
  return signEnvelope(attestation as unknown as Record<string, unknown>, priorKey, "proxy");
}

describe("KeyRegistry.register", () => {
  it("accepts a first registration for a DID without endorsement (trust-on-first-use)", async () => {
    const registry = new KeyRegistry();
    const key = await generateKeyPair(`${DID}#key-1`);
    await registry.register(DID, key.kid, Buffer.from(key.publicKey).toString("hex"), "2026-01-01T00:00:00.000Z");
    expect(registry.resolveByKid(key.kid)).toEqual(key.publicKey);
  });

  it("rejects a second registration for the same DID without an endorsement", async () => {
    const registry = new KeyRegistry();
    const key1 = await generateKeyPair(`${DID}#key-1`);
    await registry.register(DID, key1.kid, Buffer.from(key1.publicKey).toString("hex"), "2026-01-01T00:00:00.000Z");

    const key2 = await generateKeyPair(`${DID}#key-2`);
    await expect(
      registry.register(DID, key2.kid, Buffer.from(key2.publicKey).toString("hex"), "2026-02-01T00:00:00.000Z")
    ).rejects.toThrow();
  });

  it("accepts a rotation endorsed by the prior key, closing the old epoch", async () => {
    const registry = new KeyRegistry();
    const key1 = await generateKeyPair(`${DID}#key-1`);
    await registry.register(DID, key1.kid, Buffer.from(key1.publicKey).toString("hex"), "2026-01-01T00:00:00.000Z");

    const key2 = await generateKeyPair(`${DID}#key-2`);
    const pub2Hex = Buffer.from(key2.publicKey).toString("hex");
    const now = "2026-02-01T00:00:00.000Z";
    const endorsement = await endorse(key1, DID, key2.kid, pub2Hex, now);

    await registry.register(DID, key2.kid, pub2Hex, now, endorsement);

    expect(registry.resolveByKid(key2.kid)).toEqual(key2.publicKey);
    expect(registry.resolveByKid(key1.kid)).toEqual(key1.publicKey); // history preserved
    expect(registry.getHistory(DID).find((e) => e.kid === key1.kid)?.validUntil).toBe(now);
    expect(registry.getHistory(DID).find((e) => e.kid === key2.kid)?.validUntil).toBeNull();
  });

  it("rejects a rotation endorsed by the wrong key", async () => {
    const registry = new KeyRegistry();
    const key1 = await generateKeyPair(`${DID}#key-1`);
    await registry.register(DID, key1.kid, Buffer.from(key1.publicKey).toString("hex"), "2026-01-01T00:00:00.000Z");

    const key2 = await generateKeyPair(`${DID}#key-2`);
    const impostor = await generateKeyPair("impostor");
    const pub2Hex = Buffer.from(key2.publicKey).toString("hex");
    const now = "2026-02-01T00:00:00.000Z";
    const badEndorsement = await endorse(impostor, DID, key2.kid, pub2Hex, now);

    await expect(registry.register(DID, key2.kid, pub2Hex, now, badEndorsement)).rejects.toThrow();
  });

  it("is idempotent when the same kid is re-registered with the same key", async () => {
    const registry = new KeyRegistry();
    const key1 = await generateKeyPair(`${DID}#key-1`);
    const pubHex = Buffer.from(key1.publicKey).toString("hex");
    await registry.register(DID, key1.kid, pubHex, "2026-01-01T00:00:00.000Z");
    await expect(registry.register(DID, key1.kid, pubHex, "2026-01-02T00:00:00.000Z")).resolves.toBeUndefined();
    expect(registry.getHistory(DID)).toHaveLength(1);
  });

  it("rejects re-registering an existing kid under a different key", async () => {
    const registry = new KeyRegistry();
    const key1 = await generateKeyPair(`${DID}#key-1`);
    await registry.register(DID, key1.kid, Buffer.from(key1.publicKey).toString("hex"), "2026-01-01T00:00:00.000Z");

    const impostorKey = await generateKeyPair("unused");
    const impostorHex = Buffer.from(impostorKey.publicKey).toString("hex");
    await expect(registry.register(DID, key1.kid, impostorHex, "2026-01-02T00:00:00.000Z")).rejects.toThrow();
  });
});

describe("didFromKid", () => {
  it("splits the DID off of a kid string", () => {
    expect(didFromKid(`${DID}#key-1`)).toBe(DID);
  });
});

describe("KeyRegistry.get (Map-compatible alias)", () => {
  it("behaves like resolveByKid", async () => {
    const registry = new KeyRegistry();
    const key = await generateKeyPair(`${DID}#key-1`);
    await registry.register(DID, key.kid, Buffer.from(key.publicKey).toString("hex"), "2026-01-01T00:00:00.000Z");
    expect(registry.get(key.kid)).toEqual(key.publicKey);
    expect(registry.get("unknown")).toBeUndefined();
  });
});

describe("KeyRegistry.resolveAt", () => {
  it("resolves the key that was valid at a given past timestamp, even after rotation", async () => {
    const registry = new KeyRegistry();
    const key1 = await generateKeyPair(`${DID}#key-1`);
    await registry.register(DID, key1.kid, Buffer.from(key1.publicKey).toString("hex"), "2026-01-01T00:00:00.000Z");

    const key2 = await generateKeyPair(`${DID}#key-2`);
    const pub2Hex = Buffer.from(key2.publicKey).toString("hex");
    const rotatedAt = "2026-02-01T00:00:00.000Z";
    const endorsement = await endorse(key1, DID, key2.kid, pub2Hex, rotatedAt);
    await registry.register(DID, key2.kid, pub2Hex, rotatedAt, endorsement);

    expect(registry.resolveAt(DID, "2026-01-15T00:00:00.000Z")).toEqual(key1.publicKey);
    expect(registry.resolveAt(DID, "2026-03-01T00:00:00.000Z")).toEqual(key2.publicKey);
  });

  it("returns undefined for a DID with no registration", () => {
    expect(new KeyRegistry().resolveAt("did:unknown", "2026-01-01T00:00:00.000Z")).toBeUndefined();
  });
});

describe("KeyRegistry.revoke", () => {
  it("closes the active epoch and resolveAt no longer finds a valid key", async () => {
    const registry = new KeyRegistry();
    const key1 = await generateKeyPair(`${DID}#key-1`);
    const pubHex = Buffer.from(key1.publicKey).toString("hex");
    await registry.register(DID, key1.kid, pubHex, "2026-01-01T00:00:00.000Z");

    const now = "2026-02-01T00:00:00.000Z";
    const attestation = { did: DID, revoke_kid: key1.kid, timestamp: now };
    const endorsement = await signEnvelope(attestation, key1, "proxy");
    await registry.revoke(DID, now, endorsement);

    expect(registry.resolveAt(DID, "2026-03-01T00:00:00.000Z")).toBeUndefined();
    expect(registry.resolveByKid(key1.kid)).toEqual(key1.publicKey); // history preserved
  });

  it("rejects revocation when there is no active key", async () => {
    const registry = new KeyRegistry();
    const key1 = await generateKeyPair(`${DID}#key-1`);
    const attestation = { did: DID, revoke_kid: key1.kid, timestamp: "2026-01-01T00:00:00.000Z" };
    const endorsement = await signEnvelope(attestation, key1, "proxy");
    await expect(registry.revoke(DID, "2026-01-01T00:00:00.000Z", endorsement)).rejects.toThrow();
  });
});

describe("KeyRegistry *ByKid convenience methods (DRY: kid -> did derivation)", () => {
  it("registerByKid derives the DID from the kid and registers exactly like register()", async () => {
    const registry = new KeyRegistry();
    const key = await generateKeyPair(`${DID}#key-1`);
    await registry.registerByKid(key.kid, Buffer.from(key.publicKey).toString("hex"), undefined, "2026-01-01T00:00:00.000Z");
    expect(registry.resolveByKid(key.kid)).toEqual(key.publicKey);
    expect(registry.historyByKid(key.kid)).toHaveLength(1);
  });

  it("revokeByKid derives the DID from the kid and revokes exactly like revoke()", async () => {
    const registry = new KeyRegistry();
    const key = await generateKeyPair(`${DID}#key-1`);
    const pubHex = Buffer.from(key.publicKey).toString("hex");
    await registry.registerByKid(key.kid, pubHex, undefined, "2026-01-01T00:00:00.000Z");

    const now = "2026-02-01T00:00:00.000Z";
    const endorsement = await signEnvelope({ did: DID, revoke_kid: key.kid, timestamp: now }, key, "proxy");
    await registry.revokeByKid(key.kid, endorsement, now);

    expect(registry.resolveAt(DID, "2026-03-01T00:00:00.000Z")).toBeUndefined();
  });

  it("historyByKid returns the same history as getHistory(didFromKid(kid))", async () => {
    const registry = new KeyRegistry();
    const key = await generateKeyPair(`${DID}#key-1`);
    await registry.registerByKid(key.kid, Buffer.from(key.publicKey).toString("hex"), undefined, "2026-01-01T00:00:00.000Z");
    expect(registry.historyByKid(key.kid)).toEqual(registry.getHistory(DID));
  });
});
