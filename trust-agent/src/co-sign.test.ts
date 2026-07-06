import { describe, it, expect } from "vitest";
import { generateKeyPair } from "./crypto.js";
import type { KeyPair } from "./crypto.js";
import { buildIntentEnvelope, buildAcceptanceReceipt } from "./envelopes.js";
import type { IntentEnvelope, AcceptanceReceipt } from "./envelopes.js";
import {
  verifyHandshake,
  buildCoSignReceipt,
  verifyCoSignReceipt,
} from "./co-sign.js";

interface Handshake {
  intent: IntentEnvelope;
  acceptance: AcceptanceReceipt;
  proxyAKey: KeyPair;
  proxyBKey: KeyPair;
}

/** Build a valid Intent + Acceptance handshake signed by two distinct proxies. */
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

/** A key registry lookup over the two proxies for a handshake. */
function lookupFor(h: Handshake): (kid: string) => Uint8Array | undefined {
  const map = new Map<string, Uint8Array>([
    [h.proxyAKey.kid, h.proxyAKey.publicKey],
    [h.proxyBKey.kid, h.proxyBKey.publicKey],
  ]);
  return (kid) => map.get(kid);
}

describe("verifyHandshake", () => {
  it("accepts a valid Intent + Acceptance signed by known proxies", async () => {
    const h = await makeHandshake();
    await expect(verifyHandshake(h.intent, h.acceptance, lookupFor(h))).resolves.toBeUndefined();
  });

  it("rejects when the Intent signature is invalid (tampered payload)", async () => {
    const h = await makeHandshake();
    const tampered: IntentEnvelope = {
      ...h.intent,
      payload: { ...h.intent.payload, args_hash: "0".repeat(64) },
    };
    await expect(verifyHandshake(tampered, h.acceptance, lookupFor(h))).rejects.toThrow();
  });

  it("rejects when the Acceptance signature is invalid (tampered field)", async () => {
    const h = await makeHandshake();
    const tampered: AcceptanceReceipt = { ...h.acceptance, policy_eval_hash: "0".repeat(64) };
    await expect(verifyHandshake(h.intent, tampered, lookupFor(h))).rejects.toThrow();
  });

  it("rejects when a signing key is unknown to the witness", async () => {
    const h = await makeHandshake();
    const empty = () => undefined;
    await expect(verifyHandshake(h.intent, h.acceptance, empty)).rejects.toThrow(/unknown key/i);
  });

  it("rejects when acceptance does not bind the intent hash", async () => {
    const h = await makeHandshake();
    const mismatched: AcceptanceReceipt = { ...h.acceptance, intent_hash: "0".repeat(64) };
    await expect(verifyHandshake(h.intent, mismatched, lookupFor(h))).rejects.toThrow(/intent/i);
  });

  it("rejects when the acceptance decision is REJECTED", async () => {
    const h = await makeHandshake();
    const denied = await buildAcceptanceReceipt({
      intentEnvelope: h.intent,
      policyEvalInput: { decision: "REJECTED" },
      proxyKey: h.proxyBKey,
      decision: "REJECTED",
    });
    await expect(verifyHandshake(h.intent, denied, lookupFor(h))).rejects.toThrow(/reject/i);
  });

  it("rejects when trace_id of acceptance and intent diverge", async () => {
    const h = await makeHandshake();
    const other = await makeHandshake();
    await expect(verifyHandshake(h.intent, other.acceptance, lookupFor(h))).rejects.toThrow(/trace/i);
  });
});

describe("buildCoSignReceipt / verifyCoSignReceipt", () => {
  it("produces an Ed25519 co-signature verifiable under the witness key", async () => {
    const h = await makeHandshake();
    const witnessKey = await generateKeyPair("did:workload:trustagent-cloud#key-1");

    const receipt = await buildCoSignReceipt(h.intent, h.acceptance, witnessKey);

    expect(receipt.envelope_type).toBe("CoSignReceipt");
    expect(receipt.trace_id).toBe(h.intent.trace_id);
    expect(receipt.signatures).toHaveLength(1);
    expect(receipt.signatures[0].role).toBe("witness");
    expect(receipt.signatures[0].kid).toBe(witnessKey.kid);

    await expect(
      verifyCoSignReceipt(receipt, h.intent, h.acceptance, witnessKey.publicKey)
    ).resolves.toBeUndefined();
  });

  it("fails verification under a different (impostor) public key", async () => {
    const h = await makeHandshake();
    const witnessKey = await generateKeyPair("did:workload:trustagent-cloud#key-1");
    const impostor = await generateKeyPair("did:workload:impostor#key-1");

    const receipt = await buildCoSignReceipt(h.intent, h.acceptance, witnessKey);

    await expect(
      verifyCoSignReceipt(receipt, h.intent, h.acceptance, impostor.publicKey)
    ).rejects.toThrow();
  });

  it("fails verification when the receipt is re-bound to a different transaction", async () => {
    const h = await makeHandshake();
    const other = await makeHandshake();
    const witnessKey = await generateKeyPair("did:workload:trustagent-cloud#key-1");

    const receipt = await buildCoSignReceipt(h.intent, h.acceptance, witnessKey);

    await expect(
      verifyCoSignReceipt(receipt, other.intent, other.acceptance, witnessKey.publicKey)
    ).rejects.toThrow();
  });
});
