/**
 * TrustAgentAI — Proxy B HTTP Server
 *
 * Exposes two endpoints:
 *   POST /accept     — receives IntentEnvelope, returns AcceptanceReceipt
 *   POST /executed   — receives ExecutionEnvelope, records it in the ledger
 *
 * Also exposes read-only endpoints:
 *   GET  /history/:traceId   — TimestampRegistry lookup
 *   GET  /dispute/:traceId   — full Dispute Pack (entries + Merkle proofs)
 *   POST /flush              — commit pending Merkle batch
 *
 * Run:
 *   npx tsx src/proxy-server.ts
 */
export {};
//# sourceMappingURL=proxy-server.d.ts.map