/**
 * TrustAgentAI — Inline Witness Co-Signature (Delta #3)
 *
 * Pure protocol logic for the independent witness (TrustAgentAI Cloud) that
 * co-signs a transaction *inline, between handshake Phase 2 (Acceptance) and
 * Phase 3 (Execution)*. This is the "third independent key" from the threat
 * model (DISPUTE_HARDENING §3): a transaction that cannot produce a valid
 * witness co-signature is not final.
 *
 * The witness verifies BOTH proxy signatures against keys it holds
 * independently (banks register their public keys with it), so a collusion of
 * the two banks alone cannot fabricate a witnessed transaction. Network/SQL
 * wiring lives in the `trust-agent-cloud/` service; this module is the
 * testable core.
 */

import { computeEnvelopeHash, signEnvelope, verifySignature } from "./crypto.js";
import type { KeyPair, SignatureBlock } from "./crypto.js";
import type { IntentEnvelope, AcceptanceReceipt } from "./envelopes.js";

/** Resolve a signing key id to its public key, or undefined if unknown. */
export type PublicKeyLookup = (kid: string) => Uint8Array | undefined;

/**
 * A witness co-signature receipt. Binds the Intent and Acceptance content
 * hashes for one `trace_id` and carries a single Ed25519 signature under the
 * witness key (role `"witness"`). Additive to the existing wire protocol.
 */
export interface CoSignReceipt {
  envelope_type: "CoSignReceipt";
  spec_version: "0.5";
  trace_id: string;
  timestamp: string;
  intent_hash: string;
  acceptance_hash: string;
  signatures: SignatureBlock[];
}

function requireProxySignature(
  envelope: IntentEnvelope | AcceptanceReceipt,
  label: string
): SignatureBlock {
  const sig = envelope.signatures.find((s) => s.role === "proxy");
  if (!sig) throw new Error(`${label} is missing a proxy signature`);
  return sig;
}

async function verifyUnderRegistry(
  envelope: IntentEnvelope | AcceptanceReceipt,
  sig: SignatureBlock,
  lookup: PublicKeyLookup
): Promise<void> {
  const publicKey = lookup(sig.kid);
  if (!publicKey) throw new Error(`unknown key: ${sig.kid}`);
  await verifySignature(envelope as unknown as Record<string, unknown>, sig, publicKey);
}

/**
 * Validate an Intent + Acceptance handshake before the witness will co-sign.
 * Throws if anything is off:
 *  - the two envelopes disagree on `trace_id`;
 *  - the acceptance decision is not `ACCEPTED`;
 *  - the acceptance does not commit the intent's content hash;
 *  - either proxy signature is missing, from an unknown key, or invalid.
 */
export async function verifyHandshake(
  intent: IntentEnvelope,
  acceptance: AcceptanceReceipt,
  lookup: PublicKeyLookup
): Promise<void> {
  if (acceptance.trace_id !== intent.trace_id) {
    throw new Error("trace_id mismatch between intent and acceptance");
  }
  if (acceptance.decision !== "ACCEPTED") {
    throw new Error(`acceptance decision is not ACCEPTED: ${acceptance.decision}`);
  }

  const intentHash = computeEnvelopeHash(intent as unknown as Record<string, unknown>);
  if (acceptance.intent_hash !== intentHash) {
    throw new Error("acceptance does not bind the intent hash");
  }

  await verifyUnderRegistry(intent, requireProxySignature(intent, "intent"), lookup);
  await verifyUnderRegistry(acceptance, requireProxySignature(acceptance, "acceptance"), lookup);
}

/**
 * Build a witness co-signature receipt binding the intent and acceptance
 * hashes. Callers MUST run {@link verifyHandshake} first — this function only
 * signs; it does not re-validate the inputs.
 */
export async function buildCoSignReceipt(
  intent: IntentEnvelope,
  acceptance: AcceptanceReceipt,
  witnessKey: KeyPair
): Promise<CoSignReceipt> {
  const base: Omit<CoSignReceipt, "signatures"> = {
    envelope_type: "CoSignReceipt",
    spec_version: "0.5",
    trace_id: intent.trace_id,
    timestamp: new Date().toISOString(),
    intent_hash: computeEnvelopeHash(intent as unknown as Record<string, unknown>),
    acceptance_hash: computeEnvelopeHash(acceptance as unknown as Record<string, unknown>),
  };

  const sig = await signEnvelope(base as Record<string, unknown>, witnessKey, "witness");
  return { ...base, signatures: [sig] };
}

/**
 * Verify a co-sign receipt end-to-end (auditor path): the witness signature is
 * valid under `witnessPublicKey`, and the receipt still binds the given intent
 * and acceptance. Throws on any mismatch.
 */
export async function verifyCoSignReceipt(
  receipt: CoSignReceipt,
  intent: IntentEnvelope,
  acceptance: AcceptanceReceipt,
  witnessPublicKey: Uint8Array
): Promise<void> {
  const intentHash = computeEnvelopeHash(intent as unknown as Record<string, unknown>);
  const acceptanceHash = computeEnvelopeHash(acceptance as unknown as Record<string, unknown>);
  if (receipt.intent_hash !== intentHash) {
    throw new Error("co-sign receipt does not bind the given intent");
  }
  if (receipt.acceptance_hash !== acceptanceHash) {
    throw new Error("co-sign receipt does not bind the given acceptance");
  }

  const sig = receipt.signatures.find((s) => s.role === "witness");
  if (!sig) throw new Error("co-sign receipt is missing a witness signature");
  await verifySignature(receipt as unknown as Record<string, unknown>, sig, witnessPublicKey);
}
