/**
 * TrustAgentAI — Cryptographic Primitives
 * Ed25519 signatures + SHA-256 + JCS (RFC 8785)
 *
 * Dependencies:
 *   npm install @noble/ed25519 canonicalize
 *   npm install --save-dev @types/node typescript
 */
import * as ed from "@noble/ed25519";
import { createHash, randomBytes } from "crypto";
// ─── Key Generation ───────────────────────────────────────────────────────────
export async function generateKeyPair(kid) {
    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    return { privateKey, publicKey, kid };
}
// ─── Hashing ──────────────────────────────────────────────────────────────────
/**
 * Compute SHA-256( JCS(envelope WITHOUT "signatures" field) )
 * This is the canonical hash rule from A2A spec §4 "Hash Target Rule".
 */
export function computeEnvelopeHash(envelope) {
    // Strip signatures field before hashing (spec requirement)
    const { signatures: _sig, entry_hash: _eh, ...rest } = envelope;
    const canonical = JSON.stringify(rest);
    if (!canonical)
        throw new Error("JCS canonicalization failed");
    return createHash("sha256").update(canonical).digest("hex");
}
/**
 * Generic SHA-256 of any JSON-serializable value (JCS).
 */
export function sha256Json(value) {
    const canonical = JSON.stringify(value);
    if (!canonical)
        throw new Error("JCS canonicalization failed");
    return createHash("sha256").update(canonical).digest("hex");
}
/**
 * SHA-256 of raw string / Buffer.
 */
export function sha256(input) {
    return createHash("sha256").update(input).digest("hex");
}
// ─── Signing ──────────────────────────────────────────────────────────────────
/**
 * Sign an envelope with Ed25519.
 * Returns a SignatureBlock ready to push into envelope.signatures[].
 */
export async function signEnvelope(envelope, keyPair, role = "proxy", attestationRef) {
    const signed_digest = computeEnvelopeHash(envelope);
    const msgBytes = Buffer.from(signed_digest, "hex");
    const sigBytes = await ed.signAsync(msgBytes, keyPair.privateKey);
    const value = Buffer.from(sigBytes).toString("base64url");
    const block = {
        role,
        kid: keyPair.kid,
        alg: "EdDSA",
        signed_digest,
        value,
    };
    if (attestationRef)
        block.agent_attestation_ref = attestationRef;
    return block;
}
/**
 * Verify a signature block against the envelope.
 * Throws if invalid.
 */
export async function verifySignature(envelope, sig, publicKey) {
    const expectedDigest = computeEnvelopeHash(envelope);
    if (sig.signed_digest !== expectedDigest) {
        throw new Error(`signed_digest mismatch: expected ${expectedDigest}, got ${sig.signed_digest}`);
    }
    const sigBytes = Buffer.from(sig.value, "base64url");
    const msgBytes = Buffer.from(sig.signed_digest, "hex");
    const valid = await ed.verifyAsync(sigBytes, msgBytes, publicKey);
    if (!valid)
        throw new Error(`Ed25519 signature verification failed for kid=${sig.kid}`);
}
// ─── Nonce ────────────────────────────────────────────────────────────────────
export function generateNonce() {
    return randomBytes(8).toString("hex");
}
//# sourceMappingURL=crypto.js.map