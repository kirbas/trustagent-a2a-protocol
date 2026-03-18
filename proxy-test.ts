/**
 * TrustAgentAI — Proxy Integration Test
 *
 * Simulates a full A2A round-trip WITHOUT a running HTTP server:
 * Proxy A and Proxy B are instantiated in-process and communicate directly.
 *
 * This is the fastest way to verify the full flow during development.
 * For the live HTTP version, run: npx tsx src/proxy-server.ts
 */

import { generateKeyPair } from "./src/crypto.js";
import { DAGLedger } from "./src/ledger.js";
import { NonceRegistry } from "./src/nonce-registry.js";
import { RiskBudgetEngine } from "./src/risk-budget.js";
import { ProxyAGateway, ProxyBGateway, McpToolCall } from "./src/trust-proxy.js";
import { IntentEnvelope, AcceptanceReceipt } from "./src/envelopes.js";

// ── Fake in-process "network" between Proxy A and Proxy B ────────────────────

class InProcessNetwork {
  constructor(private proxyB: ProxyBGateway) {}

  async post(path: string, body: unknown): Promise<unknown> {
    if (path === "/accept") {
      const { intent, estimated_cost_usd } = body as {
        intent: IntentEnvelope;
        estimated_cost_usd?: number;
      };
      const result = await this.proxyB.handleIntent(intent, estimated_cost_usd ?? 0);
      if (result.error) throw new Error(result.error);
      return { acceptance: result.acceptance };
    }
    if (path === "/executed") {
      // fire-and-forget in real proxy, we await here for test determinism
      return { ok: true };
    }
    throw new Error(`Unknown path: ${path}`);
  }
}

// ── Patch global fetch for the in-process test ───────────────────────────────

function patchFetch(network: InProcessNetwork) {
  (global as any).fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const data = await network.post(path, body);
    return {
      ok: true,
      json: async () => data,
    } as Response;
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== TrustAgentAI Trust Proxy — Integration Test ===\n");

  // 1. Generate keys
  const proxyAKey = await generateKeyPair("did:workload:proxy-A#key-1");
  const proxyBKey = await generateKeyPair("did:workload:proxy-B#key-1");

  // 2. Wire up Proxy B
  const ledger = new DAGLedger(4);
  const nonceRegistry = new NonceRegistry();
  const budgetEngine = new RiskBudgetEngine();
  budgetEngine.registerPolicy({
    did: "did:workload:payment-agent-01",
    maxSingleActionUsd: 20_000,
    dailyBudgetUsd: 100_000,
    allowedTools: ["execute_wire_transfer", "query_balance"],
  });

  const proxyB = new ProxyBGateway({
    proxyKey: proxyBKey,
    proxyAPublicKeys: new Map([[proxyAKey.kid, proxyAKey.publicKey]]),
    nonceRegistry,
    budgetEngine,
    ledger,
  });

  // 3. Wire up Proxy A with in-process network
  const network = new InProcessNetwork(proxyB);
  patchFetch(network);

  const proxyA = new ProxyAGateway({
    proxyKey: proxyAKey,
    proxyBEndpoint: "http://proxy-b:3001", // URL is intercepted by patchFetch
    ttlSeconds: 30,
  });

  // ── Test 1: Successful wire transfer ─────────────────────────────────────
  console.log("── Test 1: Successful wire transfer ──");

  const call1: McpToolCall = {
    jsonrpc: "2.0",
    id: "req-001",
    method: "tools/call",
    params: {
      name: "execute_wire_transfer",
      arguments: {
        destination_account: "IBAN:DE89370400440532013000",
        amount_usd: 5000,
        currency: "USD",
      },
      _initiator_did: "did:workload:payment-agent-01",
      _vc_ref: "urn:credential:treasury-auth-099",
      _mcp_deployment_id: "stripe-prod-cluster-1",
      _tool_schema_hash: "e3b0c44298fc1c149afbf4c8996fb924",
      _mcp_session_id: "sess_abc123",
      _estimated_cost_usd: 5000,
    },
  };

  const result1 = await proxyA.forwardToolCall(call1, async (_call) => ({
    transaction_id: "txn_stripe_001",
    status: "settled",
    settled_at: new Date().toISOString(),
  }));

  if (result1.error) {
    console.error("✗ FAILED:", result1.error);
  } else {
    console.log("✓ Tool call accepted and executed");
    const a2a = result1.result?._a2a!;
    console.log("  trace_id:        ", a2a.intent_envelope.trace_id);
    console.log("  intent_hash:     ", a2a.acceptance_receipt.intent_hash.slice(0, 16) + "...");
    console.log("  acceptance sig:  ", a2a.acceptance_receipt.signatures[0].value.slice(0, 20) + "...");
    console.log("  execution status:", a2a.execution_envelope.status);
  }

  // ── Test 2: Budget exceeded ───────────────────────────────────────────────
  console.log("\n── Test 2: Budget exceeded (single action > $20k cap) ──");

  const call2: McpToolCall = {
    ...call1,
    id: "req-002",
    params: { ...call1.params, _estimated_cost_usd: 25_000 },
  };

  const result2 = await proxyA.forwardToolCall(call2, async () => ({}));
  if (result2.error) {
    console.log("✓ Correctly rejected:", result2.error.message);
  } else {
    console.error("✗ Should have been rejected");
  }

  // ── Test 3: Replay attack ─────────────────────────────────────────────────
  console.log("\n── Test 3: Replay attack (same call repeated) ──");
  // Note: nonce is randomly generated per call, so to test replay
  // we directly test the nonce registry
  const consumed1 = nonceRegistry.consume("did:workload:test-agent", "abc123nonce", new Date(Date.now() + 30_000).toISOString());
  const consumed2 = nonceRegistry.consume("did:workload:test-agent", "abc123nonce", new Date(Date.now() + 30_000).toISOString());
  console.log("✓ First use:", consumed1 ? "ACCEPTED" : "REJECTED");
  console.log("✓ Replay:   ", consumed2 ? "ACCEPTED (bug!)" : "REJECTED (correct)");

  // ── Test 4: Unauthorized tool ─────────────────────────────────────────────
  console.log("\n── Test 4: Unauthorized tool ──");

  const call4: McpToolCall = {
    ...call1,
    id: "req-004",
    params: { ...call1.params, name: "delete_all_records", _estimated_cost_usd: 0 },
  };

  const result4 = await proxyA.forwardToolCall(call4, async () => ({}));
  if (result4.error) {
    console.log("✓ Correctly blocked:", result4.error.message);
  } else {
    console.error("✗ Should have been blocked");
  }

  // ── Ledger state ──────────────────────────────────────────────────────────
  console.log("\n── Ledger state ──");
  const batch = ledger.flush();
  if (batch) {
    ledger.anchorBatch(batch.batch_id, "0xfakeL2TxHash");
    console.log("✓ Merkle batch committed, root:", batch.merkle_root.slice(0, 16) + "...");
  }
  console.log("  Total entries:", ledger.getAllEntries().length);
  console.log("  Total batches:", ledger.getBatches().length);

  // Dispute pack for trace 1
  if (result1.result?._a2a) {
    const traceId = result1.result._a2a.intent_envelope.trace_id;
    const pack = ledger.getDisputePack(traceId);
    console.log(`\n✓ Dispute Pack for ${traceId.slice(0, 30)}...`);
    console.log("  Artifacts:", pack.entries.map((e) => e.event_type).join(" → "));
    console.log("  Inclusion proofs:", pack.inclusionProofs.length);
  }

  console.log("\n=== Integration test complete ===");
}

main().catch(console.error);
