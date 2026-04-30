import { describe, expect, it } from "vitest";
import {
  computeEnvelopeHash,
  generateKeyPair,
  generateNonce,
  signEnvelope,
  verifySignature,
} from "./crypto.js";

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    envelope_type: "IntentEnvelope",
    spec_version: "0.4",
    trace_id: "urn:uuid:123e4567-e89b-12d3-a456-426614174000",
    timestamp: "2026-04-01T00:00:00.000Z",
    expires_at: "2026-04-01T00:00:30.000Z",
    initiator: {
      did: "did:workload:agent-a",
      vc_ref: "vc:agent-a",
    },
    target: {
      did: "did:workload:agent-b",
      mcp_deployment_id: "mcp:calendar",
      tool_name: "create_event",
      tool_schema_hash: "schema-hash",
      mcp_session_id: "session-1",
    },
    payload: {
      args_hash: "args-hash",
      nonce: "abcdef0123456789",
    },
    ...overrides,
  };
}

describe("computeEnvelopeHash", () => {
  it("is deterministic for the same envelope", () => {
    const envelope = makeEnvelope();

    expect(computeEnvelopeHash(envelope)).toBe(computeEnvelopeHash(envelope));
  });

  it("hashes the envelope without the signatures field", () => {
    const envelope = makeEnvelope();
    const signedEnvelope = {
      ...envelope,
      signatures: [
        {
          role: "proxy",
          kid: "did:workload:proxy#key-1",
          alg: "EdDSA",
          signed_digest: "ignored",
          value: "ignored",
        },
      ],
    };

    expect(computeEnvelopeHash(signedEnvelope)).toBe(computeEnvelopeHash(envelope));
  });

  it("changes when the envelope content changes", () => {
    const envelope = makeEnvelope();
    const changedEnvelope = makeEnvelope({
      payload: {
        args_hash: "different-args-hash",
        nonce: "abcdef0123456789",
      },
    });

    expect(computeEnvelopeHash(changedEnvelope)).not.toBe(computeEnvelopeHash(envelope));
  });
});

describe("signEnvelope and verifySignature", () => {
  it("signs an envelope and verifies with the matching public key", async () => {
    const envelope = makeEnvelope();
    const keyPair = await generateKeyPair("did:workload:proxy#key-1");

    const signature = await signEnvelope(envelope, keyPair, "proxy");

    expect(signature.signed_digest).toBe(computeEnvelopeHash(envelope));
    await expect(
      verifySignature({ ...envelope, signatures: [signature] }, signature, keyPair.publicKey)
    ).resolves.toBeUndefined();
  });

  it("rejects a signature checked against the wrong public key", async () => {
    const envelope = makeEnvelope();
    const signer = await generateKeyPair("did:workload:proxy#key-1");
    const other = await generateKeyPair("did:workload:other#key-1");
    const signature = await signEnvelope(envelope, signer, "proxy");

    await expect(verifySignature(envelope, signature, other.publicKey)).rejects.toThrow(
      /signature verification failed/
    );
  });

  it("rejects an envelope modified after signing", async () => {
    const envelope = makeEnvelope();
    const keyPair = await generateKeyPair("did:workload:proxy#key-1");
    const signature = await signEnvelope(envelope, keyPair, "proxy");
    const modifiedEnvelope = makeEnvelope({
      target: {
        did: "did:workload:agent-b",
        mcp_deployment_id: "mcp:calendar",
        tool_name: "delete_event",
        tool_schema_hash: "schema-hash",
        mcp_session_id: "session-1",
      },
    });

    await expect(verifySignature(modifiedEnvelope, signature, keyPair.publicKey)).rejects.toThrow(
      /signed_digest mismatch/
    );
  });
});

describe("generateNonce", () => {
  it("returns a 16-character hex string", () => {
    expect(generateNonce()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns different values across calls", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
