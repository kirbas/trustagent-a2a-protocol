/**
 * TrustAgentAI — Cryptographic Primitives
 * Ed25519 signatures + SHA-256 + JCS (RFC 8785)
 *
 * Dependencies:
 *   npm install @noble/ed25519 canonicalize
 *   npm install --save-dev @types/node typescript
 */
export interface KeyPair {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    kid: string;
}
export interface SignatureBlock {
    role: "proxy" | "agent";
    kid: string;
    alg: "EdDSA";
    signed_digest: string;
    value: string;
    agent_attestation_ref?: string;
}
export declare function generateKeyPair(kid: string): Promise<KeyPair>;
/**
 * Compute SHA-256( JCS(envelope WITHOUT "signatures" field) )
 * This is the canonical hash rule from A2A spec §4 "Hash Target Rule".
 */
export declare function computeEnvelopeHash(envelope: Record<string, unknown>): string;
/**
 * Generic SHA-256 of any JSON-serializable value (JCS).
 */
export declare function sha256Json(value: unknown): string;
/**
 * SHA-256 of raw string / Buffer.
 */
export declare function sha256(input: string | Buffer): string;
/**
 * Sign an envelope with Ed25519.
 * Returns a SignatureBlock ready to push into envelope.signatures[].
 */
export declare function signEnvelope(envelope: Record<string, unknown>, keyPair: KeyPair, role?: "proxy" | "agent", attestationRef?: string): Promise<SignatureBlock>;
/**
 * Verify a signature block against the envelope.
 * Throws if invalid.
 */
export declare function verifySignature(envelope: Record<string, unknown>, sig: SignatureBlock, publicKey: Uint8Array): Promise<void>;
export declare function generateNonce(): string;
//# sourceMappingURL=crypto.d.ts.map