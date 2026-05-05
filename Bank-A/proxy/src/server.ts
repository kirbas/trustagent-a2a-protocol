import express from "express";
import cors from "cors";
import { createHash, randomUUID } from "crypto";
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
  getEnvelopesByTraceId,
} from "./db.js";
import { SseBus } from "./sse.js";
import { registerWithProxyB } from "./key-exchange.js";

const PORT = Number(process.env.PORT ?? 3001);
const PROXY_B_URL = process.env.PROXY_B_URL ?? "http://bank-b-proxy:3002";
const DB_PATH = process.env.DB_PATH ?? "/data/bank-a.db";
const INITIATOR_DID = "did:workload:bank-a-agent";
const PROXY_KID = "did:workload:bank-a-proxy#key-1";

let triggered = false;

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

  // ── Bilateral Cross-Check ─────────────────────────────────────────────────
  app.post("/cross-check", async (req, res) => {
    const { traceId } = req.body as { traceId: string };
    if (!traceId) {
      res.status(400).json({ error: "traceId required" });
      return;
    }

    try {
      const localEnvelopes = getEnvelopesByTraceId(traceId) as Array<{ type: string; raw_payload: string; signature: string }>;
      const response = await fetch(`${PROXY_B_URL}/envelopes-by-trace/${traceId}`);
      if (!response.ok) {
        res.status(500).json({ error: "Failed to fetch envelopes from Proxy B" });
        return;
      }
      const remoteEnvelopes = await response.json() as Array<{ type: string; raw_payload: string; signature: string }>;

      // Also verify anchor
      const anchorResponse = await fetch(`${process.env.PROXY_B_URL ?? "http://bank-b-proxy:3002"}/verify-trace/${encodeURIComponent(traceId)}`);
      const anchorResult = await anchorResponse.json();
      const anchorValid = anchorResponse.ok && anchorResult.ok && anchorResult.allValid;

      const localMap = new Map(localEnvelopes.map((e) => [e.type, e]));
      const remoteMap = new Map(remoteEnvelopes.map((e) => [e.type, e]));

      const types = Array.from(new Set([...localMap.keys(), ...remoteMap.keys()]))
        .filter((t) => t !== "PROVENANCE");
      const details = types.map((type) => {
        const local = localMap.get(type);
        const remote = remoteMap.get(type);
        if (!local || !remote) {
          return { type, match: false, reason: `Missing in ${!local ? 'Bank-A' : 'Bank-B'}` };
        }
        if (local.raw_payload !== remote.raw_payload) {
          return { type, match: false, reason: "Payload mismatch" };
        }
        return { type, match: true, reason: "Synced" };
      });

      details.push({
        type: "MERKLE_ANCHOR",
        match: anchorValid,
        reason: anchorValid ? `Anchored to L2 (Block ${anchorResult.blockNumber})` : (anchorResult.error || "L2 Anchor Pending or Failed")
      });

      const synced = details.every((d) => d.match);
      res.json({ synced, details });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
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

    res.json(mcpResult);
  });

  app.listen(PORT, () => console.log(`TrustAgentAI Proxy A listening on :${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
