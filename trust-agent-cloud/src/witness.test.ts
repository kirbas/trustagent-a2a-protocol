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

async function makeHandshake(): Promise<Handshake> {
  const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
  const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
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
  svc.registerKey(h.proxyAKey.kid, Buffer.from(h.proxyAKey.publicKey).toString("hex"));
  svc.registerKey(h.proxyBKey.kid, Buffer.from(h.proxyBKey.publicKey).toString("hex"));
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

    // Second transaction: re-register the (same-kid) keys for its proxies.
    const h2 = await makeHandshake();
    svc.registerKey(h2.proxyAKey.kid, Buffer.from(h2.proxyAKey.publicKey).toString("hex"));
    svc.registerKey(h2.proxyBKey.kid, Buffer.from(h2.proxyBKey.publicKey).toString("hex"));
    const r2 = await svc.coSign(h2.intent, h2.acceptance);

    expect(r1.seq).toBe(0);
    expect(r2.seq).toBe(1);
    expect(getCoSignChain()).toHaveLength(2);
    expect(verifyCoSignChain().valid).toBe(true);
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
