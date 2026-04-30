import express from "express";
import cors from "cors";
import {
  generateKeyPair,
  ProxyBGateway,
  DAGLedger,
  NonceRegistry,
  RiskBudgetEngine,
  type IntentEnvelope,
  type ExecutionEnvelope,
} from "@trustagentai/a2a-core";
import { initDb, saveEnvelope, getEnvelopes, clearEnvelopes } from "./db.js";
import { SseBus } from "./sse.js";

const PORT = Number(process.env.PORT ?? 3002);
const DB_PATH = process.env.DB_PATH ?? "/data/bank-b.db";
const PROXY_KID = "did:workload:bank-b-proxy#key-1";
const BANK_A_DID = "did:workload:bank-a-agent";

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

  app.get("/events", (_req, res) => sseBus.addClient(res));

  app.get("/envelopes", (_req, res) => res.json(getEnvelopes()));

  app.get("/dispute/:id", (req, res) => {
    const pack = ledger.getDisputePack(req.params.id);
    res.json(pack);
  });

  app.post("/flush", (_req, res) => {
    const batch = ledger.flush();
    res.json({ ok: true, batch });
  });

  app.post("/accept", async (req, res) => {
    const { intent, estimated_cost_usd = 0 } = req.body as {
      intent: IntentEnvelope;
      estimated_cost_usd?: number;
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

  app.post("/executed", async (req, res) => {
    const { execution } = req.body as { execution: ExecutionEnvelope };
    await proxyB.handleExecution(execution);

    saveEnvelope(execution.trace_id + ":execution", "EXECUTION", execution.trace_id, execution, JSON.stringify(execution.signatures));

    sseBus.broadcast("execution-complete", {
      traceId: execution.trace_id,
      status: execution.status,
      ts: new Date().toISOString(),
    });

    console.log(`[bank-b-proxy] EXECUTED ${execution.trace_id} — ${execution.status}`);
    res.json({ ok: true });
  });

  app.listen(PORT, () => console.log(`TrustAgentAI Proxy B listening on :${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
