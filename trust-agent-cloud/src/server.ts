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
import { fileURLToPath } from "url";
import { loadOrCreateKeyPair } from "@trustagentai/a2a-core";
import type { IntentEnvelope, AcceptanceReceipt, SignatureBlock, KeyPair } from "@trustagentai/a2a-core";
import { initDb, verifyCoSignChain, clearCoSigns } from "./db.js";
import { CoSignService } from "./witness.js";
import { initBlobDb, putBlob, getBlob, clearBlobs, type BlobInput } from "./blob-db.js";

const PORT = Number(process.env.PORT ?? 3003);
const DB_PATH = process.env.DB_PATH ?? "/data/trust-agent-cloud.db";
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "/data/trust-agent-cloud-keystore.json";
const KEYSTORE_KEK = process.env.KEYSTORE_KEK;
const WITNESS_KID = "did:workload:trustagent-cloud#key-1";

export interface ServerConfig {
  dbPath: string;
  keystorePath: string;
  keystoreKek: string;
}

/** Builds the Express app and wires all routes, without binding to a port. */
export async function buildServer(config: ServerConfig): Promise<{ app: express.Express; witnessKey: KeyPair }> {
  const witnessKey = await loadOrCreateKeyPair(WITNESS_KID, config.keystorePath, config.keystoreKek);
  initDb(config.dbPath);
  initBlobDb(config.dbPath);
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

  app.post("/register-key", async (req, res) => {
    const { kid, publicKeyHex, endorsement, timestamp } = req.body as {
      kid?: string;
      publicKeyHex?: string;
      endorsement?: SignatureBlock;
      /** Required alongside `endorsement` — must be the exact timestamp the
       *  caller signed into the rotation attestation (verification hashes
       *  the attestation object, so a server-generated one would never match). */
      timestamp?: string;
    };
    if (!kid || !publicKeyHex) {
      res.status(400).json({ error: "kid and publicKeyHex are required" });
      return;
    }
    if (endorsement && !timestamp) {
      res.status(400).json({ error: "timestamp is required alongside endorsement" });
      return;
    }
    try {
      await service.registerKey(kid, publicKeyHex, endorsement, timestamp);
      console.log(`[trust-agent-cloud] registered peer key: ${kid}`);
      res.json({ ok: true });
    } catch (err) {
      console.warn(`[trust-agent-cloud] key registration refused for ${kid}`, err);
      res.status(400).json({ error: String(err) });
    }
  });

  // Delta #6: revoke the currently active key for a DID (any of its kids),
  // and read back its full epoch history (the transparency log).
  app.post("/revoke-key", async (req, res) => {
    const { kid, endorsement, timestamp } = req.body as {
      kid?: string;
      endorsement?: SignatureBlock;
      timestamp?: string;
    };
    if (!kid || !endorsement || !timestamp) {
      res.status(400).json({ error: "kid, endorsement, and timestamp are required" });
      return;
    }
    try {
      await service.revokeKey(kid, endorsement, timestamp);
      console.log(`[trust-agent-cloud] revoked key: ${kid}`);
      res.json({ ok: true });
    } catch (err) {
      console.warn(`[trust-agent-cloud] key revocation refused for ${kid}`, err);
      res.status(400).json({ error: String(err) });
    }
  });

  app.get("/key-history/:kid", (req, res) => {
    const history = service.getKeyHistory(req.params.kid).map((e) => ({
      kid: e.kid,
      publicKeyHex: Buffer.from(e.publicKey).toString("hex"),
      validFrom: e.validFrom,
      validUntil: e.validUntil,
    }));
    res.json(history);
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

  // Delta #5: WORM content store. The witness is one of the cross-held
  // copies of the encrypted (never plaintext) transaction content — it only
  // ever sees ciphertext + wrapped DEKs, and its own wrapped-DEK entry is the
  // only one it could ever unwrap.
  app.put("/blob/:contentHash", (req, res) => {
    const { contentHash } = req.params;
    const blob = req.body as BlobInput;
    if (!blob?.ciphertext || !blob?.iv || !blob?.tag || !blob?.wrappedDeks) {
      res.status(400).json({ error: "ciphertext, iv, tag, and wrappedDeks are required" });
      return;
    }
    try {
      const { created } = putBlob(contentHash, blob);
      res.status(created ? 201 : 200).json({ ok: true, created });
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  });

  app.get("/blob/:contentHash", (req, res) => {
    const blob = getBlob(req.params.contentHash);
    if (!blob) {
      res.status(404).json({ error: "blob not found" });
      return;
    }
    res.json(blob);
  });

  app.post("/reset", (_req, res) => {
    clearCoSigns();
    clearBlobs();
    res.json({ ok: true });
  });

  return { app, witnessKey };
}

async function main(): Promise<void> {
  if (!KEYSTORE_KEK) {
    throw new Error("KEYSTORE_KEK env var is required to load/create the witness identity keystore");
  }
  const { app, witnessKey } = await buildServer({
    dbPath: DB_PATH,
    keystorePath: KEYSTORE_PATH,
    keystoreKek: KEYSTORE_KEK,
  });
  app.listen(PORT, () =>
    console.log(`TrustAgentAI Cloud witness listening on :${PORT} (kid=${witnessKey.kid})`)
  );
}

// Only run the server when this file is executed directly (not when imported, e.g. by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
