/**
 * TrustAgentAI — Nonce Registry
 *
 * Anti-replay protection per A2A spec §5 "Anti-Replay (Belt and Suspenders)".
 *
 * Rule: A nonce is unique per (initiator.did, nonce) tuple.
 * Entries expire at expires_at + skew_tolerance and are purged lazily.
 */
const SKEW_TOLERANCE_MS = 5_000; // 5 seconds (spec recommendation)
export class NonceRegistry {
    store = new Map(); // key = `${did}::${nonce}`
    /**
     * Check and consume a nonce.
     * Returns true if the nonce is fresh (first use).
     * Returns false if it was already seen (replay attack).
     */
    consume(initiatorDid, nonce, expiresAt) {
        this._purgeExpired();
        const key = `${initiatorDid}::${nonce}`;
        if (this.store.has(key))
            return false; // replay detected
        const expiresAtMs = new Date(expiresAt).getTime() + SKEW_TOLERANCE_MS;
        this.store.set(key, { expiresAtMs });
        return true;
    }
    /**
     * Check TTL validity: current_time must be <= expires_at + skew_tolerance
     */
    checkExpiry(expiresAt) {
        const deadline = new Date(expiresAt).getTime() + SKEW_TOLERANCE_MS;
        return Date.now() <= deadline;
    }
    _purgeExpired() {
        const now = Date.now();
        for (const [key, entry] of this.store) {
            if (now > entry.expiresAtMs)
                this.store.delete(key);
        }
    }
    size() {
        return this.store.size;
    }
}
//# sourceMappingURL=nonce-registry.js.map