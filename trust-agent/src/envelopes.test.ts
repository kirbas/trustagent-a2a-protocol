import { describe, it, expect } from "vitest";
import { generateKeyPair } from "./crypto.js";
import { verifySignature, sha256Json } from "./crypto.js";
import {
  buildIntentEnvelope,
  buildAcceptanceReceipt,
  buildExecutionEnvelope,
  buildContentProvenanceReceipt,
} from "./envelopes.js";

async function makeIntent(overrides: Partial<Parameters<typeof buildIntentEnvelope>[0]> = {}) {
  const proxyKey = await generateKeyPair("did:workload:proxy#key-1");
  return buildIntentEnvelope({
    initiatorDid: "did:workload:agent#key-1",
    vcRef: "urn:vc:1",
    targetDid: "did:workload:bank-b#key-1",
    mcpDeploymentId: "deploy-1",
    toolName: "transfer",
    toolSchemaHash: sha256Json({ schema: "transfer-v1" }),
    mcpSessionId: "session-1",
    args: { amount: 10 },
    proxyKey,
    ...overrides,
  });
}

describe("buildIntentEnvelope", () => {
  it("builds an envelope with a proxy signature and a matching trace_id", async () => {
    const { envelope, traceId } = await makeIntent();
    expect(envelope.envelope_type).toBe("IntentEnvelope");
    expect(envelope.trace_id).toBe(traceId);
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0].role).toBe("proxy");
  });

  it("hashes args instead of storing them in plaintext", async () => {
    const { envelope } = await makeIntent({ args: { amount: 10 } });
    expect(envelope.payload.args_hash).toBe(sha256Json({ amount: 10 }));
    expect(JSON.stringify(envelope)).not.toContain("amount");
  });

  it("defaults ttl to 30s when not provided", async () => {
    const { envelope } = await makeIntent();
    const ttlMs = new Date(envelope.expires_at).getTime() - new Date(envelope.timestamp).getTime();
    expect(ttlMs).toBe(30_000);
  });

  it("honors a custom ttlSeconds", async () => {
    const { envelope } = await makeIntent({ ttlSeconds: 60 });
    const ttlMs = new Date(envelope.expires_at).getTime() - new Date(envelope.timestamp).getTime();
    expect(ttlMs).toBe(60_000);
  });

  it("adds a second agent signature for Dual-Sign when agentKey is provided", async () => {
    const agentKey = await generateKeyPair("did:workload:agent#key-1");
    const { envelope } = await makeIntent({ agentKey });
    expect(envelope.signatures).toHaveLength(2);
    expect(envelope.signatures[0].role).toBe("proxy");
    expect(envelope.signatures[1].role).toBe("agent");
  });

  it("produces a proxy signature verifiable against the proxy's public key", async () => {
    const proxyKey = await generateKeyPair("did:workload:proxy#key-1");
    const { envelope } = await makeIntent({ proxyKey });
    const { signatures, ...rest } = envelope;
    await expect(
      verifySignature(rest as Record<string, unknown>, signatures[0], proxyKey.publicKey)
    ).resolves.toBeUndefined();
  });
});

describe("buildAcceptanceReceipt", () => {
  it("binds intent_hash to the given intent envelope and defaults to ACCEPTED", async () => {
    const { envelope: intentEnvelope } = await makeIntent();
    const proxyKey = await generateKeyPair("did:workload:proxy#key-1");
    const receipt = await buildAcceptanceReceipt({
      intentEnvelope,
      policyEvalInput: { risk: "low" },
      proxyKey,
    });
    expect(receipt.trace_id).toBe(intentEnvelope.trace_id);
    expect(receipt.decision).toBe("ACCEPTED");
    expect(receipt.signatures).toHaveLength(1);
  });

  it("honors an explicit REJECTED decision", async () => {
    const { envelope: intentEnvelope } = await makeIntent();
    const proxyKey = await generateKeyPair("did:workload:proxy#key-1");
    const receipt = await buildAcceptanceReceipt({
      intentEnvelope,
      policyEvalInput: { risk: "high" },
      proxyKey,
      decision: "REJECTED",
    });
    expect(receipt.decision).toBe("REJECTED");
  });
});

describe("buildExecutionEnvelope", () => {
  it("binds intent_hash and acceptance_hash and hashes outputData", async () => {
    const { envelope: intentEnvelope } = await makeIntent();
    const proxyKey = await generateKeyPair("did:workload:proxy#key-1");
    const acceptanceReceipt = await buildAcceptanceReceipt({
      intentEnvelope,
      policyEvalInput: { risk: "low" },
      proxyKey,
    });

    const execution = await buildExecutionEnvelope({
      intentEnvelope,
      acceptanceReceipt,
      status: "COMPLETED",
      outputData: { result: "ok" },
      proxyKey,
    });

    expect(execution.trace_id).toBe(intentEnvelope.trace_id);
    expect(execution.status).toBe("COMPLETED");
    expect(execution.result.output_hash).toBe(sha256Json({ result: "ok" }));
    expect(execution.signatures).toHaveLength(1);
  });

  it("leaves signatures empty when no proxyKey is provided (Proxy B is the exclusive signer)", async () => {
    const { envelope: intentEnvelope } = await makeIntent();
    const proxyKey = await generateKeyPair("did:workload:proxy#key-1");
    const acceptanceReceipt = await buildAcceptanceReceipt({
      intentEnvelope,
      policyEvalInput: { risk: "low" },
      proxyKey,
    });

    const execution = await buildExecutionEnvelope({
      intentEnvelope,
      acceptanceReceipt,
      status: "FAILED",
      outputData: null,
    });

    expect(execution.status).toBe("FAILED");
    expect(execution.signatures).toEqual([]);
  });
});

describe("buildContentProvenanceReceipt", () => {
  it("binds execution/intent/acceptance/output hashes and content metadata", async () => {
    const { envelope: intentEnvelope } = await makeIntent();
    const proxyKey = await generateKeyPair("did:workload:proxy#key-1");
    const acceptanceReceipt = await buildAcceptanceReceipt({
      intentEnvelope,
      policyEvalInput: { risk: "low" },
      proxyKey,
    });
    const executionEnvelope = await buildExecutionEnvelope({
      intentEnvelope,
      acceptanceReceipt,
      status: "COMPLETED",
      outputData: { text: "generated content" },
      proxyKey,
    });

    const receipt = await buildContentProvenanceReceipt({
      executionEnvelope,
      content_type: "text",
      content_hash: sha256Json("generated content"),
      content_size_bytes: 18,
      model_id: "claude",
      proxyKey,
    });

    expect(receipt.trace_id).toBe(executionEnvelope.trace_id);
    expect(receipt.intent_hash).toBe(executionEnvelope.intent_hash);
    expect(receipt.acceptance_hash).toBe(executionEnvelope.acceptance_hash);
    expect(receipt.output_hash).toBe(executionEnvelope.result.output_hash);
    expect(receipt.content.content_type).toBe("text");
    expect(receipt.content.content_size_bytes).toBe(18);
    expect(receipt.context?.model_id).toBe("claude");
    expect(receipt.signatures).toHaveLength(1);
  });

  it("omits the context field entirely when no optional context is provided", async () => {
    const { envelope: intentEnvelope } = await makeIntent();
    const proxyKey = await generateKeyPair("did:workload:proxy#key-1");
    const acceptanceReceipt = await buildAcceptanceReceipt({
      intentEnvelope,
      policyEvalInput: { risk: "low" },
      proxyKey,
    });
    const executionEnvelope = await buildExecutionEnvelope({
      intentEnvelope,
      acceptanceReceipt,
      status: "COMPLETED",
      outputData: { text: "x" },
      proxyKey,
    });

    const receipt = await buildContentProvenanceReceipt({
      executionEnvelope,
      content_type: "text",
      content_hash: sha256Json("x"),
      proxyKey,
    });

    expect(receipt.context).toBeUndefined();
    expect(receipt.content.content_size_bytes).toBeUndefined();
  });
});
