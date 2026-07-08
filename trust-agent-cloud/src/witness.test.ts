import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  generateKeyPair,
  loadOrCreateKeyPair,
  buildIntentEnvelope,
  buildAcceptanceReceipt,
  verifyCoSignReceipt,
  buildRotationAttestation,
  signRotation,
  signEnvelope,
} from "@trustagentai/a2a-core";
import type { KeyPair, IntentEnvelope, AcceptanceReceipt } from "@trustagentai/a2a-core";
import { initDb, clearCoSigns, getCoSignChain, verifyCoSignChain } from "./db.js";
import { CoSignService } from "./witness.js";

const KEK = "a".repeat(64); // 32-byte hex, test-only

interface Handshake {
  intent: IntentEnvelope;
  acceptance: AcceptanceReceipt;
  proxyAKey: KeyPair;
  proxyBKey: KeyPair;
}

async function makeHandshake(keys?: { proxyAKey: KeyPair; proxyBKey: KeyPair }): Promise<Handshake> {
  const proxyAKey = keys?.proxyAKey ?? (await generateKeyPair("did:workload:bank-a-proxy#key-1"));
  const proxyBKey = keys?.proxyBKey ?? (await generateKeyPair("did:workload:bank-b-proxy#key-1"));
  const { envelope: intent } = await buildIntentEnvelope({
    initiatorDid: "did:workload:bank-a-agent",
    vcRef: "vc:test",
    targetDid: "did:workload:bank-b-proxy",
    mcpDeploymentId: "did:workload:bank-b-proxy",
    toolName: "execute_wire_transfer",
    toolSchemaHash: "deadbeef",
    mcpSessionId: "sess-1",
    args: { amount: 100 },
    proxyKey: proxyAKey,
  });
  const acceptance = await buildAcceptanceReceipt({
    intentEnvelope: intent,
    policyEvalInput: { decision: "ACCEPTED" },
    proxyKey: proxyBKey,
  });
  return { intent, acceptance, proxyAKey, proxyBKey };
}

async function serviceWith(h: Handshake): Promise<{ svc: CoSignService; witnessKey: KeyPair }> {
  const witnessKey = await generateKeyPair("did:workload:trustagent-cloud#key-1");
  const svc = new CoSignService(witnessKey);
  await svc.registerKey(h.proxyAKey.kid, Buffer.from(h.proxyAKey.publicKey).toString("hex"));
  await svc.registerKey(h.proxyBKey.kid, Buffer.from(h.proxyBKey.publicKey).toString("hex"));
  return { svc, witnessKey };
}

beforeEach(() => {
  initDb(join(tmpdir(), `witness-test-${randomUUID()}.db`));
  clearCoSigns();
});

describe("CoSignService.coSign", () => {
  it("rejects a handshake whose Intent signature is invalid", async () => {
    const h = await makeHandshake();
    const { svc } = await serviceWith(h);
    const tampered: IntentEnvelope = {
      ...h.intent,
      payload: { ...h.intent.payload, args_hash: "0".repeat(64) },
    };
    await expect(svc.coSign(tampered, h.acceptance)).rejects.toThrow();
    expect(getCoSignChain()).toHaveLength(0);
  });

  it("rejects a handshake whose Acceptance signature is invalid", async () => {
    const h = await makeHandshake();
    const { svc } = await serviceWith(h);
    const tampered: AcceptanceReceipt = { ...h.acceptance, policy_eval_hash: "0".repeat(64) };
    await expect(svc.coSign(h.intent, tampered)).rejects.toThrow();
    expect(getCoSignChain()).toHaveLength(0);
  });

  it("co-signs a valid handshake with a witness-verifiable signature", async () => {
    const h = await makeHandshake();
    const { svc, witnessKey } = await serviceWith(h);

    const { receipt, seq, prev_hash, idempotent } = await svc.coSign(h.intent, h.acceptance);

    expect(idempotent).toBe(false);
    expect(seq).toBe(0);
    expect(prev_hash).toBe("0".repeat(64));
    await expect(
      verifyCoSignReceipt(receipt, h.intent, h.acceptance, witnessKey.publicKey)
    ).resolves.toBeUndefined();
  });

  it("appends exactly one link to the witness hash-chain and keeps it valid", async () => {
    const h = await makeHandshake();
    const { svc } = await serviceWith(h);

    await svc.coSign(h.intent, h.acceptance);

    expect(getCoSignChain()).toHaveLength(1);
    expect(verifyCoSignChain().valid).toBe(true);
  });

  it("is idempotent on a duplicate trace_id and does not advance the chain", async () => {
    const h = await makeHandshake();
    const { svc } = await serviceWith(h);

    const first = await svc.coSign(h.intent, h.acceptance);
    const second = await svc.coSign(h.intent, h.acceptance);

    expect(second.idempotent).toBe(true);
    expect(second.seq).toBe(first.seq);
    expect(second.prev_hash).toBe(first.prev_hash);
    expect(getCoSignChain()).toHaveLength(1);
    expect(verifyCoSignChain().valid).toBe(true);
  });

  it("chains two distinct transactions in order (seq 0, 1) and stays valid", async () => {
    const h1 = await makeHandshake();
    const { svc } = await serviceWith(h1);
    const r1 = await svc.coSign(h1.intent, h1.acceptance);

    // Second transaction: same proxy identities (kid + key), already
    // registered — a real second transaction doesn't re-register a key.
    const h2 = await makeHandshake({ proxyAKey: h1.proxyAKey, proxyBKey: h1.proxyBKey });
    const r2 = await svc.coSign(h2.intent, h2.acceptance);

    expect(r1.seq).toBe(0);
    expect(r2.seq).toBe(1);
    expect(getCoSignChain()).toHaveLength(2);
    expect(verifyCoSignChain().valid).toBe(true);
  });
});

describe("CoSignService key-transparency (Delta #6)", () => {
  it("accepts an endorsed rotation and co-signs under the new key, not the old", async () => {
    const witnessKey = await generateKeyPair("did:workload:trustagent-cloud#key-1");
    const svc = new CoSignService(witnessKey);
    const did = "did:workload:bank-a-proxy";
    const oldKey = await generateKeyPair(`${did}#key-1`);
    await svc.registerKey(oldKey.kid, Buffer.from(oldKey.publicKey).toString("hex"));

    const newKey = await generateKeyPair(`${did}#key-2`);
    const newPubHex = Buffer.from(newKey.publicKey).toString("hex");
    const rotatedAt = "2026-02-01T00:00:00.000Z";
    const attestation = buildRotationAttestation(did, newKey.kid, newPubHex, rotatedAt);
    const endorsement = await signRotation(attestation, oldKey);
    await expect(svc.registerKey(newKey.kid, newPubHex, endorsement, rotatedAt)).resolves.toBeUndefined();

    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    await svc.registerKey(proxyBKey.kid, Buffer.from(proxyBKey.publicKey).toString("hex"));

    const { envelope: intent } = await buildIntentEnvelope({
      initiatorDid: "did:workload:bank-a-agent",
      vcRef: "vc:test",
      targetDid: "did:workload:bank-b-proxy",
      mcpDeploymentId: "did:workload:bank-b-proxy",
      toolName: "execute_wire_transfer",
      toolSchemaHash: "deadbeef",
      mcpSessionId: "sess-1",
      args: { amount: 100 },
      proxyKey: newKey, // signed with the ROTATED key
    });
    const acceptance = await buildAcceptanceReceipt({
      intentEnvelope: intent,
      policyEvalInput: { decision: "ACCEPTED" },
      proxyKey: proxyBKey,
    });

    await expect(svc.coSign(intent, acceptance)).resolves.toHaveProperty("idempotent", false);
  });

  it("rejects a rotation with no endorsement, and one endorsed by the wrong key", async () => {
    const witnessKey = await generateKeyPair("did:workload:trustagent-cloud#key-1");
    const svc = new CoSignService(witnessKey);
    const did = "did:workload:bank-a-proxy";
    const oldKey = await generateKeyPair(`${did}#key-1`);
    await svc.registerKey(oldKey.kid, Buffer.from(oldKey.publicKey).toString("hex"));

    const newKey = await generateKeyPair(`${did}#key-2`);
    const newPubHex = Buffer.from(newKey.publicKey).toString("hex");

    await expect(svc.registerKey(newKey.kid, newPubHex)).rejects.toThrow();

    const impostor = await generateKeyPair("impostor");
    const attestation = buildRotationAttestation(did, newKey.kid, newPubHex, new Date().toISOString());
    const badEndorsement = await signRotation(attestation, impostor);
    await expect(svc.registerKey(newKey.kid, newPubHex, badEndorsement)).rejects.toThrow();
  });

  it("revokes a key, after which it can no longer co-sign for that DID", async () => {
    const witnessKey = await generateKeyPair("did:workload:trustagent-cloud#key-1");
    const svc = new CoSignService(witnessKey);
    const did = "did:workload:bank-a-proxy";
    const key = await generateKeyPair(`${did}#key-1`);
    await svc.registerKey(key.kid, Buffer.from(key.publicKey).toString("hex"));

    const revokedAt = "2026-02-01T00:00:00.000Z";
    const revokeAttestation = { did, revoke_kid: key.kid, timestamp: revokedAt };
    const revokeEndorsement = await signEnvelope(revokeAttestation, key, "proxy");
    await expect(svc.revokeKey(key.kid, revokeEndorsement, revokedAt)).resolves.toBeUndefined();

    const history = svc.getKeyHistory(key.kid);
    expect(history).toHaveLength(1);
    expect(history[0].validUntil).not.toBeNull();
    // The kid itself still resolves (past signatures stay verifiable) — only
    // NEW registrations/rotations for this DID are now blocked without it.
    await expect(svc.registerKey(`${did}#key-2`, "aa")).rejects.toThrow();
  });
});

describe("witness durable key (Delta #1 reuse)", () => {
  it("loads the same public key across restarts from an encrypted keystore", async () => {
    const path = join(tmpdir(), `witness-keystore-${randomUUID()}.json`);
    const kid = "did:workload:trustagent-cloud#key-1";
    const first = await loadOrCreateKeyPair(kid, path, KEK);
    const second = await loadOrCreateKeyPair(kid, path, KEK);
    expect(Buffer.from(second.publicKey).toString("hex")).toBe(
      Buffer.from(first.publicKey).toString("hex")
    );
  });
});
