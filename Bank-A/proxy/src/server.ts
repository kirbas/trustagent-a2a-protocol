import express from "express";
import cors from "cors";
import { createHash, randomUUID } from "crypto";
import { ethers } from "ethers";
import {
  generateKeyPair,
  ProxyAGateway,
  buildContentProvenanceReceipt,
  type McpToolCall,
} from "@trustagentai/a2a-core";
import {
  initDb,
  saveEnvelope,
  getEnvelopes,
  saveProvenance,
  clearEnvelopes,
  getRecentEnvelopeData,
  saveAnchor,
  saveAnchorLeaves,
  getAnchorByTxHash,
  getAnchorLeaves,
} from "./db.js";
import { SseBus } from "./sse.js";
import { registerWithProxyB } from "./key-exchange.js";

const PORT = Number(process.env.PORT ?? 3001);
const PROXY_B_URL = process.env.PROXY_B_URL ?? "http://bank-b-proxy:3002";
const DB_PATH = process.env.DB_PATH ?? "/data/bank-a.db";
const INITIATOR_DID = "did:workload:bank-a-agent";
const PROXY_KID = "did:workload:bank-a-proxy#key-1";
const BASE_SEPOLIA_CHAIN_ID = 84532n;
const BASESCAN_TX_URL = "https://sepolia.basescan.org/tx/";

let triggered = false;

// ── Merkle helpers ─────────────────────────────────────────────────────────

function sha256buf(data: Buffer): Buffer {
  return Buffer.from(createHash("sha256").update(data).digest());
}

interface MerkleLeafData {
  leafIndex: number;
  envelopeId: string;
  leafHash: string;
  proofPath: Array<{ hash: string; position: "left" | "right" }>;
}

function buildMerkleTree(
  signatures: string[],
  envelopeIds: string[]
): { root: string; leaves: MerkleLeafData[] } {
  if (signatures.length === 0) throw new Error("Empty signatures");

  // Build padded levels (Bitcoin-style: duplicate last node on odd-length levels)
  const levels: Buffer[][] = [];
  let current: Buffer[] = signatures.map(
    (s) => createHash("sha256").update(s).digest() as unknown as Buffer
  );

  while (current.length > 1) {
    if (current.length % 2 === 1) current = [...current, current[current.length - 1]];
    levels.push(current);
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(sha256buf(Buffer.concat([current[i], current[i + 1]])));
    }
    current = next;
  }
  levels.push(current); // root level

  const root = levels[levels.length - 1][0].toString("hex");
  const n = signatures.length;

  const leaves: MerkleLeafData[] = [];
  for (let i = 0; i < n; i++) {
    const proofPath: Array<{ hash: string; position: "left" | "right" }> = [];
    let idx = i;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const level = levels[lvl];
      if (idx % 2 === 0) {
        proofPath.push({ hash: level[idx + 1].toString("hex"), position: "right" });
      } else {
        proofPath.push({ hash: level[idx - 1].toString("hex"), position: "left" });
      }
      idx = Math.floor(idx / 2);
    }
    leaves.push({ leafIndex: i, envelopeId: envelopeIds[i], leafHash: levels[0][i].toString("hex"), proofPath });
  }

  return { root, leaves };
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

// ── Blockchain anchor ──────────────────────────────────────────────────────

async function anchorToChain(
  merkleRoot: string,
  rpcUrl: string,
  privateKey: string
): Promise<{ txHash: string; blockNumber: number }> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const tx = await wallet.sendTransaction({
    to: wallet.address,
    value: 0n,
    data: "0x" + merkleRoot,
    chainId: BASE_SEPOLIA_CHAIN_ID,
  });
  const receipt = await tx.wait();
  return { txHash: receipt!.hash, blockNumber: receipt!.blockNumber };
}

async function runAnchor(traceId: string, bus: SseBus): Promise<void> {
  const rpcUrl = process.env.RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  if (!rpcUrl || !privateKey) {
    console.warn("[anchor] RPC_URL or PRIVATE_KEY not set — skipping anchor");
    return;
  }

  const envelopeData = getRecentEnvelopeData(10);
  if (!envelopeData.length) return;

  const { root: merkleRoot, leaves } = buildMerkleTree(
    envelopeData.map((e) => e.signature),
    envelopeData.map((e) => e.id)
  );
  const batchId = randomUUID();
  const ts = new Date().toISOString();

  saveAnchor({ batchId, merkleRoot, status: "PENDING" });
  bus.broadcast("anchor-pending", { traceId, merkleRoot: "0x" + merkleRoot, ts });
  console.log(`[anchor] batch ${batchId}: 0x${merkleRoot}`);

  const { txHash, blockNumber } = await anchorToChain(merkleRoot, rpcUrl, privateKey);

  saveAnchor({ batchId, merkleRoot, txHash, blockNumber, status: "CONFIRMED" });
  saveAnchorLeaves(batchId, leaves.map((l) => ({
    leafIndex: l.leafIndex,
    envelopeId: l.envelopeId,
    leafHash: l.leafHash,
    proofPath: JSON.stringify(l.proofPath),
  })));

  const basescanUrl = BASESCAN_TX_URL + txHash;
  bus.broadcast("anchor-complete", {
    traceId,
    merkleRoot: "0x" + merkleRoot,
    txHash,
    blockNumber,
    basescanUrl,
    ts: new Date().toISOString(),
  });
  console.log(`[anchor] confirmed at block ${blockNumber} → ${basescanUrl}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const proxyKey = await generateKeyPair(PROXY_KID);
  initDb(DB_PATH);
  const sseBus = new SseBus();

  const proxyA = new ProxyAGateway({
    proxyKey,
    proxyBEndpoint: PROXY_B_URL,
    ttlSeconds: 60,
  });

  const publicKeyHex = Buffer.from(proxyKey.publicKey).toString("hex");
  await registerWithProxyB(PROXY_B_URL, PROXY_KID, publicKeyHex);

  const app = express();
  app.use(express.json());
  app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/trigger", (_req, res) => {
    triggered = true;
    sseBus.broadcast("demo-triggered", { ts: new Date().toISOString() });
    res.json({ ok: true });
  });

  app.post("/trigger-done", (_req, res) => {
    triggered = false;
    res.json({ ok: true });
  });

  app.post("/reset", (_req, res) => {
    triggered = false;
    clearEnvelopes();
    sseBus.broadcast("demo-reset", { ts: new Date().toISOString() });
    res.json({ ok: true });
  });

  app.get("/trigger-status", (_req, res) => res.json({ triggered }));

  app.post("/thought", (req, res) => {
    sseBus.broadcast("thought", {
      source: "bank-a",
      text: req.body.text,
      ts: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  app.get("/events", (req, res) => sseBus.addClient(res));

  app.get("/envelopes", (_req, res) => res.json(getEnvelopes()));

  // ── Verify anchor dispute pack ────────────────────────────────────────────
  app.get("/verify/:txHash", (req, res) => {
    const raw = req.params.txHash;
    const txHash = raw.startsWith("0x") ? raw : "0x" + raw;
    const anchor = getAnchorByTxHash(txHash);
    if (!anchor) {
      res.status(404).json({ error: `No anchor found for tx ${txHash}` });
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
      txHash: anchor.tx_hash,
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

  app.post("/invoke", async (req, res) => {
    const { tool, args, cost } = req.body as {
      tool: string;
      args: Record<string, unknown>;
      cost: number;
    };
    const sha256str = (s: string) => createHash("sha256").update(s).digest("hex");

    const call: McpToolCall = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name: tool,
        arguments: args,
        _initiator_did: INITIATOR_DID,
        _vc_ref: "vc:bank-a:compliance-cert-2026",
        _mcp_deployment_id: "did:workload:bank-b-proxy",
        _tool_schema_hash: sha256str(tool),
        _mcp_session_id: randomUUID(),
        _estimated_cost_usd: cost,
      },
    };

    const mcpResult = await proxyA.forwardToolCall(call, async () => ({
      result: "Security Report PDF — TrustAgentAI v0.5 Provenance-Linked",
      generated_at: new Date().toISOString(),
      report_id: randomUUID(),
    }));

    const ts = new Date().toISOString();

    if (mcpResult.error) {
      const rejectedTraceId = (mcpResult.error.data as { traceId?: string } | undefined)?.traceId;
      if (rejectedTraceId) {
        runAnchor(rejectedTraceId, sseBus).catch((err) =>
          console.error("[anchor-error]", err)
        );
      }
      res.status(400).json(mcpResult);
      return;
    }

    const { intent_envelope: intent, acceptance_receipt: acceptance, execution_envelope: execution } =
      mcpResult.result!._a2a!;

    saveEnvelope(intent.trace_id + ":intent", "INTENT", intent.trace_id, intent, JSON.stringify(intent.signatures));
    saveEnvelope(acceptance.trace_id + ":acceptance", "ACCEPTANCE", acceptance.trace_id, acceptance, JSON.stringify(acceptance.signatures));
    saveEnvelope(execution.trace_id + ":execution", "EXECUTION", execution.trace_id, execution, JSON.stringify(execution.signatures));

    sseBus.broadcast("execution-complete", {
      traceId: execution.trace_id,
      status: execution.status,
      tool,
      cost,
      ts,
    });
    sseBus.broadcast("envelope", { type: "EXECUTION", traceId: execution.trace_id, ts });

    const outputStr = JSON.stringify(mcpResult.result!.content);
    const contentHash = createHash("sha256").update(outputStr).digest("hex");

    const cpr = await buildContentProvenanceReceipt({
      executionEnvelope: execution,
      content_type: "text",
      content_hash: contentHash,
      content_size_bytes: outputStr.length,
      tool_name: tool,
      model_id: "a2a-demo-agent",
      proxyKey,
    });

    saveEnvelope(cpr.trace_id + ":provenance", "PROVENANCE", cpr.trace_id, cpr, JSON.stringify(cpr.signatures));
    saveProvenance(cpr.content.content_hash, cpr.trace_id, JSON.stringify(cpr.signatures));
    sseBus.broadcast("envelope", { type: "PROVENANCE", traceId: cpr.trace_id, ts });

    runAnchor(execution.trace_id, sseBus).catch((err) =>
      console.error("[anchor-error]", err)
    );

    res.json(mcpResult);
  });

  app.listen(PORT, () => console.log(`TrustAgentAI Proxy A listening on :${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
