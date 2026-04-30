/**
 * TrustAgentAI — Nonce Registry
 *
 * Anti-replay protection per A2A spec §5 "Anti-Replay (Belt and Suspenders)".
 *
 * Rule: A nonce is unique per (initiator.did, nonce) tuple.
 * Entries expire at expires_at + skew_tolerance and are purged lazily.
 */
export declare class NonceRegistry {
    private store;
    /**
     * Check and consume a nonce.
     * Returns true if the nonce is fresh (first use).
     * Returns false if it was already seen (replay attack).
     */
    consume(initiatorDid: string, nonce: string, expiresAt: string): boolean;
    /**
     * Check TTL validity: current_time must be <= expires_at + skew_tolerance
     */
    checkExpiry(expiresAt: string): boolean;
    private _purgeExpired;
    size(): number;
}
//# sourceMappingURL=nonce-registry.d.ts.map