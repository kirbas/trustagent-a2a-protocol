import express from "express";
import cors from "cors";
import { createHash, randomUUID } from "crypto";
import { fileURLToPath } from "url";
import {
  loadOrCreateKeyPair,
  ProxyAGateway,
  buildContentProvenanceReceipt,
  buildWormRecord,
  canonicalBytes,
  sha256Json,
  computeEnvelopeHash,
  DegradedModeGate,
  reconciliationStatus,
  type McpToolCall,
  type Holder,
  type DegradedRecord,
} from "@trustagentai/a2a-core";
import {
  initDb,
  setSseBus,
  saveEnvelope,
  getEnvelopes,
  saveProvenance,
  clearEnvelopes,
  getEnvelopesByTraceId,
  saveThought,
  getThoughts,
  verifyEnvelopeChain,
} from "./db.js";
import { initWormDb, putContentBlob } from "./worm-db.js";
import { SseBus } from "./sse.js";
import { registerWithProxyB, registerWithWitness } from "./key-exchange.js";

const PORT = Number(process.env.PORT ?? 3001);
const PROXY_B_URL = process.env.PROXY_B_URL ?? "http://bank-b-proxy:3002";
const TRUSTAGENT_URL = process.env.TRUSTAGENT_URL;
const DB_PATH = process.env.DB_PATH ?? "/data/bank-a.db";
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "/data/bank-a-keystore.json";
const KEYSTORE_KEK = process.env.KEYSTORE_KEK;
const INITIATOR_DID = "did:workload:bank-a-agent";
const PROXY_KID = "did:workload:bank-a-proxy#key-1";
const WORM_DB_PATH = process.env.WORM_DB_PATH ?? DB_PATH;

/**
 * Delta #7: degraded-mode fallback config (Decision #8/#9). Disabled by
 * default — a witness outage hard-fails, matching pre-Delta-7 behavior.
 * Opt in with DEGRADED_MODE_ENABLED=true.
 */
const DEGRADED_MODE_ENABLED = process.env.DEGRADED_MODE_ENABLED === "true";
const DEGRADED_MAX_VALUE_USD = Number(process.env.DEGRADED_MAX_VALUE_USD ?? 1000);
const DEGRADED_MAX_PER_WINDOW = Number(process.env.DEGRADED_MAX_PER_WINDOW ?? 3);
const DEGRADED_WINDOW_SECONDS = Number(process.env.DEGRADED_WINDOW_SECONDS ?? 3600);
const DEGRADED_RECONCILIATION_SECONDS = Number(process.env.DEGRADED_RECONCILIATION_SECONDS ?? 900);
const DEGRADED_NO_SIGNATURE = "none — degraded record, no witness signature available";

let triggered = false;

/**
 * Delta #5: content-encryption KEKs, one per WORM holder. Distinct from the
 * identity KEYSTORE_KEK above — these wrap per-transaction DEKs, not signing
 * keys. Optional: if any is missing the WORM store is disabled for this run
 * (existing happy-path keeps working; see docs/execution_plan.md §5).
 */
function parseContentKek(envVar: string): Buffer | undefined {
  const value = process.env[envVar];
  if (!value) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${envVar} must be 64 hex characters (32 bytes)`);
  }
  return Buffer.from(value, "hex");
}

export interface ServerConfig {
  dbPath: string;
  wormDbPath: string;
  keystorePath: string;
  keystoreKek: string;
}

export async function buildServer(config: ServerConfig): Promise<{ app: express.Express }> {
  const proxyKey = await loadOrCreateKeyPair(PROXY_KID, config.keystorePath, config.keystoreKek);

  initDb(config.dbPath);
  initWormDb(config.wormDbPath);
  const sseBus = new SseBus();
  setSseBus(sseBus);

  // Delta #5: WORM content store holders. Bank-A is the plaintext origin, so
  // it builds the encrypted record and wraps the DEK for every cross-held
  // party plus a regulator escrow entry that TrustAgentAI cannot unwrap
  // (DISPUTE_HARDENING §5.4).
  const bankAKek = parseContentKek("BANK_A_CONTENT_KEK");
  const clientKek = parseContentKek("CLIENT_CONTENT_KEK");
  const witnessContentKek = parseContentKek("TRUSTAGENT_CONTENT_KEK");
  const regulatorKek = parseContentKek("REGULATOR_ESCROW_KEK");
  const wormHolders: Holder[] | undefined =
    bankAKek && clientKek && witnessContentKek
      ? [
          { id: "bank-a", kek: bankAKek },
          { id: "client", kek: clientKek },
          { id: "witness", kek: witnessContentKek },
        ]
      : undefined;
  const wormEscrow: Holder | undefined = regulatorKek ? { id: "regulator", kek: regulatorKek } : undefined;
  if (!wormHolders || !wormEscrow) {
    console.warn("[worm] content-KEK env vars not fully configured — WORM content store disabled");
  }

  async function storeWormContent(value: unknown): Promise<void> {
    if (!wormHolders || !wormEscrow) return;
    try {
      const plaintext = canonicalBytes(value);
      const record = buildWormRecord(plaintext, wormHolders, wormEscrow);
      putContentBlob(record.contentHash, record);
      if (TRUSTAGENT_URL) {
        await fetch(`${TRUSTAGENT_URL}/blob/${record.contentHash}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ciphertext: record.ciphertext,
            iv: record.iv,
            tag: record.tag,
            wrappedDeks: record.wrappedDeks,
          }),
        });
      }
    } catch (e) {
      console.warn("[worm] failed to store/cross-push content blob", e);
    }
  }

  const degradedModeGate = DEGRADED_MODE_ENABLED
    ? new DegradedModeGate({
        maxValueUsd: DEGRADED_MAX_VALUE_USD,
        maxDegradedPerWindow: DEGRADED_MAX_PER_WINDOW,
        windowSeconds: DEGRADED_WINDOW_SECONDS,
        reconciliationSeconds: DEGRADED_RECONCILIATION_SECONDS,
      })
    : undefined;
  if (!degradedModeGate) {
    console.warn("[degraded-mode] disabled — a witness outage will hard-fail transactions (set DEGRADED_MODE_ENABLED=true to opt in)");
  }

  const proxyA = new ProxyAGateway({
    proxyKey,
    proxyBEndpoint: PROXY_B_URL,
    witnessEndpoint: TRUSTAGENT_URL,
    degradedMode: degradedModeGate,
    ttlSeconds: 60,
  });

  const publicKeyHex = Buffer.from(proxyKey.publicKey).toString("hex");
  try {
    await registerWithProxyB(PROXY_B_URL, PROXY_KID, publicKeyHex);
  } catch (e) {
    console.warn("[key-exchange] registration failed", e);
  }

  // Delta #3: register our key with the independent witness so it can verify
  // our Intent signature before co-signing (finality gate).
  if (TRUSTAGENT_URL) {
    try {
      await registerWithWitness(TRUSTAGENT_URL, PROXY_KID, publicKeyHex);
    } catch (e) {
      console.warn("[key-exchange] witness registration failed", e);
    }
  }

  const app = express();
  app.use(express.json());
  app.use(cors({ origin: "*" }));
  app.use((req, _res, next) => {
    console.log(`[bank-a-proxy] ${req.method} ${req.url}`);
    next();
  });

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
    const { source = "bank-a", text } = req.body;
    const ts = new Date().toISOString();
    saveThought(source, text);
    sseBus.broadcast("thought", { source, text, ts });
    res.json({ ok: true });
  });

  app.get("/events", (_req, res) => sseBus.addClient(res));

  app.get("/envelopes", (_req, res) => res.json(getEnvelopes()));
  app.get("/thoughts", (_req, res) => res.json(getThoughts()));
  app.get("/verify-chain", (_req, res) => res.json(verifyEnvelopeChain()));

  // Delta #7: reconcile a degraded transaction by retrying the witness
  // co-sign once it's back. A no-op if already reconciled.
  app.post("/reconcile/:traceId", async (req, res) => {
    if (!TRUSTAGENT_URL) {
      res.status(400).json({ error: "no witness configured" });
      return;
    }
    const traceId = req.params.traceId;
    const rows = getEnvelopesByTraceId(traceId) as Array<{ type: string; raw_payload: string }>;
    const intentRow = rows.find((r) => r.type === "INTENT");
    const acceptanceRow = rows.find((r) => r.type === "ACCEPTANCE");
    if (rows.some((r) => r.type === "COSIGN")) {
      res.json({ ok: true, alreadyReconciled: true });
      return;
    }
    if (!intentRow || !acceptanceRow) {
      res.status(404).json({ error: `no intent/acceptance found for trace ${traceId}` });
      return;
    }
    try {
      const intent = JSON.parse(intentRow.raw_payload);
      const acceptance = JSON.parse(acceptanceRow.raw_payload);
      const resp = await fetch(`${TRUSTAGENT_URL}/co-sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, acceptance }),
      });
      const body = await resp.json() as { cosign_receipt?: any; error?: string };
      if (!resp.ok || !body.cosign_receipt) {
        res.status(502).json({ ok: false, error: body.error ?? "witness declined to co-sign" });
        return;
      }
      saveEnvelope(traceId + ":cosign", "COSIGN", traceId, body.cosign_receipt, JSON.stringify(body.cosign_receipt.signatures));
      sseBus.broadcast("envelope", { type: "COSIGN", traceId, ts: new Date().toISOString() });
      console.log(`[bank-a-proxy] RECONCILED ${traceId}`);
      res.json({ ok: true, cosign_receipt: body.cosign_receipt });
    } catch (err) {
      res.status(502).json({ ok: false, error: String(err) });
    }
  });

  // Delta #7: audit-side status of a degraded transaction — RECONCILED once
  // a COSIGN row exists for the trace, EXPIRED_UNRECONCILED past the
  // deadline with none, PENDING otherwise.
  app.get("/degraded-status/:traceId", (req, res) => {
    const traceId = req.params.traceId;
    const rows = getEnvelopesByTraceId(traceId) as Array<{ type: string; raw_payload: string }>;
    const degradedRow = rows.find((r) => r.type === "DEGRADED");
    if (!degradedRow) {
      res.status(404).json({ error: `no degraded record for trace ${traceId}` });
      return;
    }
    const record: DegradedRecord = JSON.parse(degradedRow.raw_payload);
    const hasCoSign = rows.some((r) => r.type === "COSIGN");
    res.json({ ...record, status: reconciliationStatus(record, hasCoSign, new Date().toISOString()) });
  });

  app.post("/cross-check", async (req, res) => {
    const { traceId } = req.body as { traceId: string };
    if (!traceId) {
      res.status(400).json({ error: "traceId required" });
      return;
    }

    try {
      const localEnvelopes = getEnvelopesByTraceId(traceId) as Array<{ type: string; raw_payload: string; signature: string }>;
      const response = await fetch(`${PROXY_B_URL}/envelopes-by-trace/${encodeURIComponent(traceId)}`);
      if (!response.ok) {
        res.status(500).json({ error: `Proxy B returned ${response.status} for trace ${traceId}` });
        return;
      }
      const remoteEnvelopes = await response.json() as Array<{ type: string; raw_payload: string; signature: string }>;

      // Also verify anchor
      const anchorResponse = await fetch(`${PROXY_B_URL}/verify-trace/${encodeURIComponent(traceId)}`);
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
          return { type, match: false, reason: `Missing in ${!local ? "Bank-A" : "Bank-B"}` };
        }
        if (local.raw_payload !== remote.raw_payload) {
          let debug = "payload differs";
          try {
            const lp = JSON.parse(local.raw_payload);
            const rp = JSON.parse(remote.raw_payload);
            const lSigs = lp.signatures?.length ?? 0;
            const rSigs = rp.signatures?.length ?? 0;
            if (lSigs !== rSigs) debug = `sig count: Bank-A=${lSigs} Bank-B=${rSigs}`;
            else debug = `sig count matches (${lSigs}) — content differs`;
          } catch { /* keep default */ }
          return { type, match: false, reason: `Payload mismatch — ${debug}` };
        }
        return { type, match: true, reason: "Synced" };
      });

      details.push({
        type: "MERKLE_ANCHOR",
        match: anchorValid,
        reason: anchorValid ? `Anchored to L2 (Block ${anchorResult.blockNumber})` : (anchorResult.error || "L2 Anchor Pending or Failed")
      });

      // Verify cryptographic causal chain: acceptance.intent_hash == hash(intent), execution.acceptance_hash == hash(acceptance)
      const intentEnv  = remoteMap.get("INTENT");
      const acceptEnv  = remoteMap.get("ACCEPTANCE");
      const execEnv    = remoteMap.get("EXECUTION");
      if (intentEnv && acceptEnv && execEnv) {
        const intent     = JSON.parse(intentEnv.raw_payload) as Record<string, unknown>;
        const acceptance = JSON.parse(acceptEnv.raw_payload) as Record<string, unknown>;
        const execution  = JSON.parse(execEnv.raw_payload) as Record<string, unknown>;
        const intentHash     = computeEnvelopeHash(intent);
        const acceptanceHash = computeEnvelopeHash(acceptance);
        const chainOk =
          (acceptance as any).intent_hash    === intentHash &&
          (execution as any).intent_hash     === intentHash &&
          (execution as any).acceptance_hash === acceptanceHash;
        details.push({
          type: "CAUSAL_CHAIN",
          match: chainOk,
          reason: chainOk
            ? "intent_hash → acceptance_hash → execution binding verified"
            : "Causal chain broken — hash binding mismatch",
        });
      }

      const synced = details.every((d) => d.match);
      res.json({ synced, details, localCount: localEnvelopes.length, remoteCount: remoteEnvelopes.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/invoke", async (req, res) => {
    const { tool, args = {}, cost = 0 } = req.body as {
      tool: string;
      args?: Record<string, unknown>;
      cost?: number;
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

    const executor = async () => ({
      result: "Security Report PDF — TrustAgentAI v0.5 Provenance-Linked",
      generated_at: new Date().toISOString(),
      report_id: randomUUID(),
    });

    try {
      let mcpResult = await proxyA.forwardToolCall(call, executor);

      if (mcpResult.error?.message?.includes("Unknown key")) {
        console.log("[bank-a-proxy] key not recognized by Proxy B — re-registering and retrying");
        await registerWithProxyB(PROXY_B_URL, PROXY_KID, publicKeyHex);
        mcpResult = await proxyA.forwardToolCall(call, executor);
      }

      const ts = new Date().toISOString();

      if (mcpResult.error) {
        res.status(400).json(mcpResult);
        return;
      }

      const { intent_envelope: intent, acceptance_receipt: acceptance, execution_envelope: execution, cosign_receipt: cosign, degraded_record: degraded } =
        mcpResult.result!._a2a!;

      saveEnvelope(intent.trace_id + ":intent", "INTENT", intent.trace_id, intent, JSON.stringify(intent.signatures));
      saveEnvelope(acceptance.trace_id + ":acceptance", "ACCEPTANCE", acceptance.trace_id, acceptance, JSON.stringify(acceptance.signatures));
      saveEnvelope(execution.trace_id + ":execution", "EXECUTION", execution.trace_id, execution, JSON.stringify(execution.signatures));

      // Delta #3: persist the independent witness co-signature alongside the
      // handshake envelopes so it is visible in the dispute pack / UI.
      if (cosign) {
        saveEnvelope(cosign.trace_id + ":cosign", "COSIGN", cosign.trace_id, cosign, JSON.stringify(cosign.signatures));
      }

      // Delta #7: the witness was unreachable but degraded-mode allowed the
      // transaction to proceed anyway (capped, tracked). Persisted honestly
      // as its own row — never mistaken for a witness co-signature — with a
      // reconcile_by deadline; see GET /degraded-status/:traceId.
      if (degraded) {
        saveEnvelope(degraded.trace_id + ":degraded", "DEGRADED", degraded.trace_id, degraded, DEGRADED_NO_SIGNATURE);
        console.warn(`[bank-a-proxy] DEGRADED ${degraded.trace_id} — ${degraded.reason} (reconcile by ${degraded.reconcile_by})`);
      }

      sseBus.broadcast("envelope", { type: "INTENT", traceId: intent.trace_id, tool, cost, ts });
      sseBus.broadcast("envelope", { type: "ACCEPTANCE", traceId: acceptance.trace_id, ts });
      if (cosign) {
        sseBus.broadcast("envelope", { type: "COSIGN", traceId: cosign.trace_id, ts });
      }
      if (degraded) {
        sseBus.broadcast("envelope", { type: "DEGRADED", traceId: degraded.trace_id, ts });
      }

      sseBus.broadcast("execution-complete", {
        traceId: execution.trace_id,
        status: execution.status,
        tool,
        cost,
        ts,
      });
      sseBus.broadcast("envelope", { type: "EXECUTION", traceId: execution.trace_id, ts });

      // Delta #5: persist args/outputData as encrypted, content-addressed WORM
      // blobs. Today only sha256Json(args)/sha256Json(outputData) survive in
      // the envelopes (args_hash/output_hash) — this makes the plaintext they
      // commit to recoverable by a holder, without ever storing it in the
      // clear ourselves.
      const outputData: unknown = JSON.parse(mcpResult.result!.content[0].text);
      await storeWormContent(args);
      await storeWormContent(outputData);

      const contentHash = sha256Json(mcpResult.result!.content);
      const contentSize = Buffer.byteLength(JSON.stringify(mcpResult.result!.content));

      const cpr = await buildContentProvenanceReceipt({
        executionEnvelope: execution,
        content_type: "text",
        content_hash: contentHash,
        content_size_bytes: contentSize,
        tool_name: tool,
        model_id: "a2a-demo-agent",
        proxyKey,
      });

      saveEnvelope(cpr.trace_id + ":provenance", "PROVENANCE", cpr.trace_id, cpr, JSON.stringify(cpr.signatures));
      saveProvenance(cpr.content.content_hash, cpr.trace_id, JSON.stringify(cpr.signatures));
      sseBus.broadcast("envelope", { type: "PROVENANCE", traceId: cpr.trace_id, ts });

      res.json(mcpResult);
    } catch (err) {
      console.error("[invoke] error:", err);
      res.status(400).json({ error: String(err) });
    }
  });

  return { app };
}

async function main(): Promise<void> {
  if (!KEYSTORE_KEK) {
    throw new Error("KEYSTORE_KEK env var is required to load/create the proxy identity keystore");
  }
  const { app } = await buildServer({
    dbPath: DB_PATH,
    wormDbPath: WORM_DB_PATH,
    keystorePath: KEYSTORE_PATH,
    keystoreKek: KEYSTORE_KEK,
  });
  app.listen(PORT, () => console.log(`TrustAgentAI Proxy A listening on :${PORT}`));
}

// Only run the server when this file is executed directly (not when imported, e.g. by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
