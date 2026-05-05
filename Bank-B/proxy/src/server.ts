import express from "express";
import cors from "cors";
import { createHash } from "crypto";
import {
  generateKeyPair,
  ProxyBGateway,
  DAGLedger,
  NonceRegistry,
  RiskBudgetEngine,
  type IntentEnvelope,
  type ExecutionEnvelope,
  signEnvelope,
} from "@trustagentai/a2a-core";
import { initDb, saveEnvelope, getEnvelopes, clearEnvelopes, getEnvelopesByTraceId, getAnchorByTxHash, getAnchorByTraceId, getAnchorLeaves, getDisputePackByTraceId } from "./db.js";
import { SseBus } from "./sse.js";

const PORT = Number(process.env.PORT ?? 3002);
const DB_PATH = process.env.DB_PATH ?? "/data/bank-b.db";
const PROXY_KID = "did:workload:bank-b-proxy#key-1";
const BANK_A_DID = "did:workload:bank-a-agent";
const ANCHOR_URL = process.env.ANCHOR_URL ?? "http://bank-b-anchor:5001";
const BASESCAN_TX_URL = "https://sepolia.basescan.org/tx/";

// ── Merkle helpers ─────────────────────────────────────────────────────────

function sha256buf(data: Buffer): Buffer {
  return Buffer.from(createHash("sha256").update(data).digest());
}

function verifyProof(leafHash: string, proofPath: Array<{ hash: string; position: string }>, expectedRoot: string): boolean {
  let current = leafHash;
  for (const step of proofPath) {
    const combined = step.position === "right"
      ? Buffer.from(current + step.hash, "hex")
      : Buffer.from(step.hash + current, "hex");
    current = sha256buf(combined).toString("hex");
  }
  return current === expectedRoot;
}

// Module-level state so /reset can recreate it without restarting the server
let ledger: DAGLedger;
let nonceRegistry: NonceRegistry;
let budgetEngine: RiskBudgetEngine;
let proxyB: ProxyBGateway;

function initProxyB(proxyBKey: Awaited<ReturnType<typeof generateKeyPair>>, proxyAPublicKeys: Map<string, Uint8Array>) {
  ledger = new DAGLedger();
  nonceRegistry = new NonceRegistry();
  budgetEngine = new RiskBudgetEngine();
  budgetEngine.registerPolicy({
    did: BANK_A_DID,
    maxSingleActionUsd: 10_000,
    dailyBudgetUsd: 10_000,
    allowedTools: ["get_security_report", "execute_wire_transfer"],
  });
  proxyB = new ProxyBGateway({
    proxyKey: proxyBKey,
    proxyAPublicKeys,
    nonceRegistry,
    budgetEngine,
    ledger,
  });
}

async function main(): Promise<void> {
  const proxyKey = await generateKeyPair(PROXY_KID);
  initDb(DB_PATH);
  const sseBus = new SseBus();

  const proxyAPublicKeys = new Map<string, Uint8Array>();
  initProxyB(proxyKey, proxyAPublicKeys);

  async function runAnchor(traceId: string) {
    try {
      sseBus.broadcast("anchor-pending", { traceId, ts: new Date().toISOString() });
      const response = await fetch(`${ANCHOR_URL}/anchor`, { method: "POST" });
      const data = await response.json();
      if (response.ok && data.status === "success") {
        const traceIds: string[] = data.traceIds || [traceId];
        traceIds.forEach((tid) => {
          sseBus.broadcast("anchor-complete", {
            traceId: tid,
            merkleRoot: data.merkleRoot,
            txHash: data.txHash,
            blockNumber: data.blockNumber,
            basescanUrl: data.basescanUrl,
            ts: new Date().toISOString()
          });
          console.log(`[bank-b-proxy] ANCHORED ${tid} — block ${data.blockNumber}`);
        });
      } else if (response.ok && data.status === "noop") {
        console.log(`[bank-b-proxy] Anchor noop for ${traceId} (already anchored or nothing pending)`);
      } else {
        const errorMsg = data.error || data.message || "Unknown error";
        console.error(`[bank-b-proxy] Anchor failed for ${traceId}:`, errorMsg);
        sseBus.broadcast("anchor-failed", { traceId, error: errorMsg, ts: new Date().toISOString() });
      }
    } catch (err) {
      console.error(`[bank-b-proxy] Anchor request failed for ${traceId}:`, err);
      sseBus.broadcast("anchor-failed", { traceId, error: String(err), ts: new Date().toISOString() });
    }
  }

  const app = express();
  app.use(express.json());
  app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/register-peer-key", (req, res) => {
    const { kid, publicKeyHex } = req.body as { kid: string; publicKeyHex: string };
    proxyAPublicKeys.set(kid, Buffer.from(publicKeyHex, "hex"));
    console.log(`[bank-b-proxy] registered peer key: ${kid}`);
    res.json({ ok: true });
  });

  app.post("/reset", (_req, res) => {
    initProxyB(proxyKey, proxyAPublicKeys);
    clearEnvelopes();
    sseBus.broadcast("demo-reset", { ts: new Date().toISOString() });
    console.log("[bank-b-proxy] state reset");
    res.json({ ok: true });
  });

  app.post("/thought", (req, res) => {
    sseBus.broadcast("thought", {
      source: "bank-b",
      text: req.body.text,
      ts: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  app.get("/envelopes", (_req, res) => res.json(getEnvelopes()));

  app.get("/dispute/:id", (req, res) => {
    // Try in-memory ledger first, fallback to DB
    let pack = ledger.getDisputePack(req.params.id);
    if (!pack || pack.entries.length === 0) {
      pack = getDisputePackByTraceId(req.params.id) as any;
    }
    res.json(pack);
  });

  app.post("/flush", (_req, res) => {
    const batch = ledger.flush();
    res.json({ ok: true, batch });
  });

  app.post("/accept", async (req, res) => {
    const { intent, estimated_cost_usd = 0 } = req.body as {
      intent: IntentEnvelope;
      estimated_cost_usd: number;
    };

    const ts = new Date().toISOString();
    const tool = intent.target?.tool_name;
    const traceId = intent.trace_id;

    const result = await proxyB.handleIntent(intent, estimated_cost_usd);

    if (result.error || !result.acceptance) {
      saveEnvelope(traceId + ":intent", "INTENT", traceId, intent, JSON.stringify(intent.signatures));
      if (result.denial) {
        saveEnvelope(traceId + ":denied", "DENIED", traceId, result.denial, JSON.stringify(result.denial.signatures));
      }

      sseBus.broadcast("intent-rejected", {
        traceId,
        tool,
        cost: estimated_cost_usd,
        errorCode: result.errorCode,
        reason: result.error,
        ts,
      });

      console.log(`[bank-b-proxy] REJECTED ${traceId} — ${result.error}`);
      res.status(400).json({ error: result.error, errorCode: result.errorCode });
      runAnchor(traceId);
      return;
    }

    saveEnvelope(traceId + ":intent", "INTENT", traceId, intent, JSON.stringify(intent.signatures));
    saveEnvelope(traceId + ":acceptance", "ACCEPTANCE", traceId, result.acceptance, JSON.stringify(result.acceptance.signatures));

    sseBus.broadcast("intent-accepted", {
      traceId,
      tool,
      cost: estimated_cost_usd,
      ts,
    });

    console.log(`[bank-b-proxy] ACCEPTED ${traceId} — tool=${tool} cost=${estimated_cost_usd}`);
    res.json({ acceptance: result.acceptance });
  });

  app.post("/anchor", async (_req, res) => {
    try {
      const response = await fetch(`${ANCHOR_URL}/anchor`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        res.status(500).json(data);
        return;
      }
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/envelopes-by-trace/:traceId", (req, res) => {
    sseBus.broadcast("cross-check-result", { traceId: req.params.traceId, ts: new Date().toISOString() });
    res.json(getEnvelopesByTraceId(req.params.traceId));
  });

  app.get("/verify/:txHash", (req, res) => {
    const raw = req.params.txHash;
    const txHash = raw.startsWith("0x") ? raw.slice(2) : raw;
    const anchor = getAnchorByTxHash(txHash);
    if (!anchor) {
      res.status(404).json({ error: `No anchor found for tx ${txHash}` });
      return;
    }

    const leaves = getAnchorLeaves(anchor.batch_id);
    const verifiedLeaves = leaves.map((leaf) => {
      const proofPath = JSON.parse(leaf.proof_path) as Array<{ hash: string; position: string }>;
      
      // Fetch the actual envelope to show full flow verification
      const envelopes = getEnvelopesByTraceId(leaf.trace_id || "");
      const envelope = envelopes.find((e: any) => e.id === leaf.envelope_id);

      return {
        leafIndex: leaf.leaf_index,
        envelopeId: leaf.envelope_id,
        traceId: leaf.trace_id ?? null,
        envelopeType: leaf.envelope_type ?? null,
        leafHash: leaf.leaf_hash,
        proofPath,
        proofValid: verifyProof(leaf.leaf_hash, proofPath, anchor.merkle_root),
        payload: envelope ? JSON.parse((envelope as any).raw_payload) : null,
      };
    });

    res.json({
      ok: true,
      txHash: "0x" + anchor.tx_hash,
      blockNumber: anchor.block_number,
      merkleRoot: "0x" + anchor.merkle_root,
      batchId: anchor.batch_id,
      anchoredAt: anchor.created_at,
      leafCount: verifiedLeaves.length,
      allValid: verifiedLeaves.every((l) => l.proofValid),
      basescanUrl: BASESCAN_TX_URL + anchor.tx_hash,
      leaves: verifiedLeaves,
    });
  });

  app.get("/verify-trace/:traceId", (req, res) => {
    const traceId = req.params.traceId;
    const anchor = getAnchorByTraceId(traceId);
    if (!anchor) {
      res.status(404).json({ error: `No anchor found for trace ${traceId}` });
      return;
    }

    const leaves = getAnchorLeaves(anchor.batch_id);
    const verifiedLeaves = leaves.map((leaf) => {
      const proofPath = JSON.parse(leaf.proof_path) as Array<{ hash: string; position: string }>;
      return {
        leafIndex: leaf.leaf_index,
        envelopeId: leaf.envelope_id,
        traceId: leaf.trace_id ?? null,
        envelopeType: leaf.envelope_type ?? null,
        leafHash: leaf.leaf_hash,
        proofPath,
        proofValid: verifyProof(leaf.leaf_hash, proofPath, anchor.merkle_root),
      };
    });

    res.json({
      ok: true,
      txHash: "0x" + anchor.tx_hash,
      blockNumber: anchor.block_number,
      merkleRoot: "0x" + anchor.merkle_root,
      batchId: anchor.batch_id,
      anchoredAt: anchor.created_at,
      leafCount: verifiedLeaves.length,
      allValid: verifiedLeaves.every((l) => l.proofValid),
      basescanUrl: BASESCAN_TX_URL + anchor.tx_hash,
      leaves: verifiedLeaves,
    });
  });

  app.post("/executed", async (req, res) => {
    const { execution } = req.body as { execution: ExecutionEnvelope };
    
    // Dual-sign the execution envelope
    const sig = await signEnvelope(execution as unknown as Record<string, unknown>, proxyKey, "proxy");
    execution.signatures.push(sig);

    await proxyB.handleExecution(execution);

    saveEnvelope(execution.trace_id + ":execution", "EXECUTION", execution.trace_id, execution, JSON.stringify(execution.signatures));

    sseBus.broadcast("execution-complete", {
      traceId: execution.trace_id,
      status: execution.status,
      ts: new Date().toISOString(),
    });

    console.log(`[bank-b-proxy] EXECUTED ${execution.trace_id} — ${execution.status}`);
    res.json({ ok: true, execution });

    // Automatically trigger anchoring after execution is processed
    runAnchor(execution.trace_id);
  });

  app.listen(PORT, () => console.log(`TrustAgentAI Proxy B listening on :${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
