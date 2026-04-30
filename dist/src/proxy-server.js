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
import { createServer } from "http";
import { generateKeyPair } from "./crypto.js";
import { DAGLedger } from "./ledger.js";
import { NonceRegistry } from "./nonce-registry.js";
import { RiskBudgetEngine } from "./risk-budget.js";
import { ProxyBGateway } from "./trust-proxy.js";
const PORT = Number(process.env.PORT ?? 3001);
// ── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap() {
    // Proxy B key pair
    const proxyBKey = await generateKeyPair("did:workload:proxy-B#key-1");
    console.log("Proxy B key:", proxyBKey.kid);
    console.log("Proxy B pubkey (hex):", Buffer.from(proxyBKey.publicKey).toString("hex"));
    // Proxy A's public key — in production loaded from a Key Registry / DID resolver
    // For demo: generate one and print it so Proxy A can use it
    const proxyAKey = await generateKeyPair("did:workload:proxy-A#key-1");
    console.log("\n[DEMO] Proxy A pubkey (hex):", Buffer.from(proxyAKey.publicKey).toString("hex"));
    console.log("[DEMO] Proxy A privkey (hex):", Buffer.from(proxyAKey.privateKey).toString("hex"));
    // Wiring
    const nonceRegistry = new NonceRegistry();
    const ledger = new DAGLedger(8);
    const budgetEngine = new RiskBudgetEngine();
    budgetEngine.registerPolicy({
        did: "did:workload:payment-agent-01",
        maxSingleActionUsd: 20_000,
        dailyBudgetUsd: 100_000,
        allowedTools: ["execute_wire_transfer", "create_invoice", "query_balance"],
    });
    const proxyAPublicKeys = new Map([
        [proxyAKey.kid, proxyAKey.publicKey],
    ]);
    const proxyB = new ProxyBGateway({
        proxyKey: proxyBKey,
        proxyAPublicKeys,
        nonceRegistry,
        budgetEngine,
        ledger,
    });
    // ── HTTP Server ─────────────────────────────────────────────────────────────
    const server = createServer(async (req, res) => {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";
        // Parse body
        const body = await readBody(req);
        // CORS
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", "application/json");
        // ── POST /accept ──────────────────────────────────────────────────────────
        if (method === "POST" && url === "/accept") {
            try {
                const { intent, estimated_cost_usd } = body;
                const result = await proxyB.handleIntent(intent, estimated_cost_usd ?? 0);
                if (result.error) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: result.error, code: result.errorCode }));
                    return;
                }
                res.writeHead(200);
                res.end(JSON.stringify({ acceptance: result.acceptance }));
            }
            catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: String(e) }));
            }
            return;
        }
        // ── POST /executed ────────────────────────────────────────────────────────
        if (method === "POST" && url === "/executed") {
            try {
                const { execution } = body;
                await proxyB.handleExecution(execution);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
            }
            catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: String(e) }));
            }
            return;
        }
        // ── POST /flush ───────────────────────────────────────────────────────────
        if (method === "POST" && url === "/flush") {
            const batch = ledger.flush();
            if (!batch) {
                res.writeHead(200);
                res.end(JSON.stringify({ message: "No pending entries to flush" }));
                return;
            }
            // Simulate L2 anchor
            const fakeTxHash = "0x" + Buffer.from(batch.merkle_root, "hex").toString("hex");
            ledger.anchorBatch(batch.batch_id, fakeTxHash);
            res.writeHead(200);
            res.end(JSON.stringify({ batch }));
            return;
        }
        // ── GET /history/:traceId ─────────────────────────────────────────────────
        const histMatch = url.match(/^\/history\/(.+)$/);
        if (method === "GET" && histMatch) {
            const traceId = decodeURIComponent(histMatch[1]);
            const records = ledger.getHistory(traceId);
            res.writeHead(200);
            res.end(JSON.stringify({ trace_id: traceId, records }));
            return;
        }
        // ── GET /dispute/:traceId ─────────────────────────────────────────────────
        const disputeMatch = url.match(/^\/dispute\/(.+)$/);
        if (method === "GET" && disputeMatch) {
            const traceId = decodeURIComponent(disputeMatch[1]);
            const pack = ledger.getDisputePack(traceId);
            res.writeHead(200);
            res.end(JSON.stringify({ trace_id: traceId, ...pack }));
            return;
        }
        // ── GET /health ───────────────────────────────────────────────────────────
        if (method === "GET" && url === "/health") {
            res.writeHead(200);
            res.end(JSON.stringify({
                status: "ok",
                proxy_kid: proxyBKey.kid,
                ledger_entries: ledger.getAllEntries().length,
                batches: ledger.getBatches().length,
                nonces_tracked: nonceRegistry.size(),
            }));
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
    });
    server.listen(PORT, () => {
        console.log(`\nTrustAgentAI Proxy B listening on http://localhost:${PORT}`);
        console.log("Endpoints:");
        console.log("  POST /accept          — submit IntentEnvelope");
        console.log("  POST /executed        — record ExecutionEnvelope");
        console.log("  POST /flush           — commit Merkle batch");
        console.log("  GET  /history/:id     — TimestampRegistry lookup");
        console.log("  GET  /dispute/:id     — Dispute Pack");
        console.log("  GET  /health          — server status");
    });
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            try {
                const raw = Buffer.concat(chunks).toString("utf-8");
                resolve(raw ? JSON.parse(raw) : {});
            }
            catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}
bootstrap().catch(console.error);
//# sourceMappingURL=proxy-server.js.map