/**
 * TrustAgentAI Cloud — witness HTTP server (Delta #3)
 *
 * The independent inline co-signer. Endpoints:
 *   GET  /health        — liveness + witness key id
 *   POST /register-key  — a bank registers its proxy public key { kid, publicKeyHex }
 *   POST /co-sign       — { intent, acceptance } → { cosign_receipt, seq, prev_hash }
 *   GET  /verify-chain  — verify the witness append-only hash-chain
 *   POST /reset         — clear the witness chain (demo only)
 *
 * The witness holds its OWN durable Ed25519 key (Delta #1) under its OWN KEK,
 * separate from both banks and from the database.
 */

import express from "express";
import cors from "cors";
import { loadOrCreateKeyPair } from "@trustagentai/a2a-core";
import type { IntentEnvelope, AcceptanceReceipt } from "@trustagentai/a2a-core";
import { initDb, verifyCoSignChain, clearCoSigns } from "./db.js";
import { CoSignService } from "./witness.js";

const PORT = Number(process.env.PORT ?? 3003);
const DB_PATH = process.env.DB_PATH ?? "/data/trust-agent-cloud.db";
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "/data/trust-agent-cloud-keystore.json";
const KEYSTORE_KEK = process.env.KEYSTORE_KEK;
const WITNESS_KID = "did:workload:trustagent-cloud#key-1";

async function main(): Promise<void> {
  if (!KEYSTORE_KEK) {
    throw new Error("KEYSTORE_KEK env var is required to load/create the witness identity keystore");
  }
  const witnessKey = await loadOrCreateKeyPair(WITNESS_KID, KEYSTORE_PATH, KEYSTORE_KEK);
  initDb(DB_PATH);
  const service = new CoSignService(witnessKey);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cors({ origin: "*" }));
  app.use((req, _res, next) => {
    console.log(`[trust-agent-cloud] ${req.method} ${req.url}`);
    next();
  });

  app.get("/health", (_req, res) =>
    res.json({ ok: true, witness_kid: witnessKey.kid })
  );

  app.post("/register-key", (req, res) => {
    const { kid, publicKeyHex } = req.body as { kid?: string; publicKeyHex?: string };
    if (!kid || !publicKeyHex) {
      res.status(400).json({ error: "kid and publicKeyHex are required" });
      return;
    }
    service.registerKey(kid, publicKeyHex);
    console.log(`[trust-agent-cloud] registered peer key: ${kid}`);
    res.json({ ok: true });
  });

  app.post("/co-sign", async (req, res) => {
    const { intent, acceptance } = req.body as {
      intent?: IntentEnvelope;
      acceptance?: AcceptanceReceipt;
    };
    if (!intent || !acceptance) {
      res.status(400).json({ error: "intent and acceptance are required" });
      return;
    }
    try {
      const { receipt, seq, prev_hash, idempotent } = await service.coSign(intent, acceptance);
      console.log(
        `[trust-agent-cloud] CO-SIGNED ${intent.trace_id} — seq=${seq}${idempotent ? " (idempotent)" : ""}`
      );
      res.json({ cosign_receipt: receipt, seq, prev_hash, idempotent });
    } catch (err) {
      console.warn(`[trust-agent-cloud] REFUSED ${intent.trace_id} — ${err}`);
      res.status(400).json({ error: String(err) });
    }
  });

  app.get("/verify-chain", (_req, res) => res.json(verifyCoSignChain()));

  app.post("/reset", (_req, res) => {
    clearCoSigns();
    res.json({ ok: true });
  });

  app.listen(PORT, () =>
    console.log(`TrustAgentAI Cloud witness listening on :${PORT} (kid=${witnessKey.kid})`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
