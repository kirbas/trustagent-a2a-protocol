import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import request from "supertest";
import type { Express } from "express";
import { generateKeyPair, buildIntentEnvelope } from "@trustagentai/a2a-core";
import { buildServer } from "./server.js";

const KEK = "e".repeat(64);
const BANK_A_DID = "did:workload:bank-a-agent";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Seeds a single-leaf anchored batch directly (bypassing the anchor service) so proofValid can be exercised. */
function seedAnchor(dbPath: string, envelopeId: string, traceId: string) {
  const leafHash = "a".repeat(64);
  const raw = new Database(dbPath);
  const now = new Date().toISOString();
  raw
    .prepare(
      "INSERT INTO envelopes (id, type, trace_id, raw_payload, signature, created_at, seq, prev_hash) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"
    )
    .run(envelopeId, "INTENT", traceId, JSON.stringify({ trace_id: traceId }), "sig", now, "0".repeat(64));
  raw
    .prepare(
      "INSERT INTO anchors (batch_id, merkle_root, tx_hash, block_number, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run("batch-1", leafHash, "cafebabe", 42, "CONFIRMED", now);
  raw
    .prepare(
      "INSERT INTO anchor_leaves (batch_id, leaf_index, envelope_id, leaf_hash, proof_path) VALUES (?, ?, ?, ?, ?)"
    )
    .run("batch-1", 0, envelopeId, leafHash, JSON.stringify([]));
  raw.close();
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

/**
 * Installs a fetch mock. Requests to the Decision Agent
 * (bank-b-agent:4002/decide) and the anchor service are dispatched to
 * per-test handlers when provided; otherwise they throw, which server.ts
 * already handles as "unreachable, fall back to static policy / report error".
 */
function installFetch(handlers: Record<string, (opts?: { body?: string }) => Response | Promise<Response>> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts?: { body?: string }) => {
      const u = String(url);
      for (const suffix of Object.keys(handlers)) {
        if (u.endsWith(suffix)) return handlers[suffix](opts);
      }
      throw new Error(`unexpected fetch to ${u}`);
    })
  );
}

async function freshApp(
  handlers: Record<string, (opts?: { body?: string }) => Response | Promise<Response>> = {}
): Promise<{ app: Express; dbPath: string }> {
  installFetch(handlers);
  const dbPath = join(tmpdir(), `bank-b-server-test-${randomUUID()}.db`);
  const { app } = await buildServer({
    dbPath,
    keystorePath: join(tmpdir(), `bank-b-server-keystore-${randomUUID()}.json`),
    keystoreKek: KEK,
  });
  return { app, dbPath };
}

async function registerProxyAAndBuildIntent(app: Express, overrides: Partial<Parameters<typeof buildIntentEnvelope>[0]> = {}) {
  const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
  await request(app)
    .post("/register-peer-key")
    .send({ kid: proxyAKey.kid, publicKeyHex: Buffer.from(proxyAKey.publicKey).toString("hex") })
    .expect(200);
  const { envelope: intent } = await buildIntentEnvelope({
    initiatorDid: BANK_A_DID,
    vcRef: "vc:test",
    targetDid: "did:workload:bank-b-proxy",
    mcpDeploymentId: "did:workload:bank-b-proxy",
    toolName: "execute_wire_transfer",
    toolSchemaHash: "deadbeef",
    mcpSessionId: "sess-1",
    args: { amount: 100 },
    proxyKey: proxyAKey,
    ...overrides,
  });
  return { intent, proxyAKey };
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /health", () => {
  it("reports ok", async () => {
    const { app } = await freshApp();
    const res = await request(app).get("/health").expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("POST /register-peer-key", () => {
  it("registers a valid key", async () => {
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const res = await request(app)
      .post("/register-peer-key")
      .send({ kid: key.kid, publicKeyHex: Buffer.from(key.publicKey).toString("hex") })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("400s when required fields are missing", async () => {
    const { app } = await freshApp();
    const res = await request(app).post("/register-peer-key").send({}).expect(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("400s when endorsement is given without a timestamp", async () => {
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const res = await request(app)
      .post("/register-peer-key")
      .send({
        kid: key.kid,
        publicKeyHex: Buffer.from(key.publicKey).toString("hex"),
        endorsement: { role: "proxy", kid: key.kid, signature: "x" },
      })
      .expect(400);
    expect(res.body.error).toMatch(/timestamp is required/);
  });

  it("400s when rotating to a new kid with no endorsement", async () => {
    const { app } = await freshApp();
    const oldKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    await request(app)
      .post("/register-peer-key")
      .send({ kid: oldKey.kid, publicKeyHex: Buffer.from(oldKey.publicKey).toString("hex") })
      .expect(200);

    const newKey = await generateKeyPair("did:workload:bank-a-proxy#key-2");
    const res = await request(app)
      .post("/register-peer-key")
      .send({ kid: newKey.kid, publicKeyHex: Buffer.from(newKey.publicKey).toString("hex") })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });
});

describe("POST /revoke-peer-key", () => {
  it("400s when required fields are missing", async () => {
    const { app } = await freshApp();
    const res = await request(app).post("/revoke-peer-key").send({}).expect(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("revokes a registered key given a valid self-endorsement", async () => {
    const { signEnvelope } = await import("@trustagentai/a2a-core");
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    await request(app)
      .post("/register-peer-key")
      .send({ kid: key.kid, publicKeyHex: Buffer.from(key.publicKey).toString("hex") })
      .expect(200);

    const revokedAt = new Date().toISOString();
    const endorsement = await signEnvelope(
      { did: "did:workload:bank-a-proxy", revoke_kid: key.kid, timestamp: revokedAt },
      key,
      "proxy"
    );
    const res = await request(app)
      .post("/revoke-peer-key")
      .send({ kid: key.kid, endorsement, timestamp: revokedAt })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("400s when the endorsement is invalid", async () => {
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    await request(app)
      .post("/register-peer-key")
      .send({ kid: key.kid, publicKeyHex: Buffer.from(key.publicKey).toString("hex") })
      .expect(200);

    const res = await request(app)
      .post("/revoke-peer-key")
      .send({ kid: key.kid, endorsement: { role: "proxy", kid: key.kid, signature: "bogus" }, timestamp: new Date().toISOString() })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });
});

describe("GET /key-history/:kid", () => {
  it("returns the epoch history for a registered kid", async () => {
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const hex = Buffer.from(key.publicKey).toString("hex");
    await request(app).post("/register-peer-key").send({ kid: key.kid, publicKeyHex: hex }).expect(200);

    const res = await request(app).get(`/key-history/${key.kid}`).expect(200);
    expect(res.body[0]).toMatchObject({ kid: key.kid, publicKeyHex: hex });
  });
});

describe("POST /thought", () => {
  it("persists and returns a thought", async () => {
    const { app } = await freshApp();
    await request(app).post("/thought").send({ source: "bank-b", text: "hello" }).expect(200);
    const res = await request(app).get("/thoughts").expect(200);
    expect(res.body[0]).toMatchObject({ source: "bank-b", text: "hello" });
  });
});

describe("GET /envelopes, /anchors, /verify-chain", () => {
  it("start empty and verify-chain reports a valid empty chain", async () => {
    const { app } = await freshApp();
    expect((await request(app).get("/envelopes").expect(200)).body).toEqual([]);
    expect((await request(app).get("/anchors").expect(200)).body).toEqual([]);
    expect((await request(app).get("/verify-chain").expect(200)).body.valid).toBe(true);
  });
});

describe("POST /flush", () => {
  it("flushes the in-memory ledger (no pending entries -> null batch)", async () => {
    const { app } = await freshApp();
    const res = await request(app).post("/flush").expect(200);
    expect(res.body).toEqual({ ok: true, batch: null });
  });
});

describe("POST /accept and GET /dispute/:id", () => {
  it("accepts a valid intent within the registered policy and records it on the ledger", async () => {
    const { app } = await freshApp();
    const { intent } = await registerProxyAAndBuildIntent(app);

    const res = await request(app).post("/accept").send({ intent, estimated_cost_usd: 10 }).expect(200);
    expect(res.body.acceptance?.decision).toBe("ACCEPTED");

    const dispute = await request(app).get(`/dispute/${intent.trace_id}`).expect(200);
    expect(dispute.body.entries.length).toBeGreaterThan(0);
  });

  it("rejects and persists a denial when the initiator has no registered policy", async () => {
    const { app } = await freshApp();
    const { intent } = await registerProxyAAndBuildIntent(app, { initiatorDid: "did:workload:unregistered-agent" });

    const res = await request(app).post("/accept").send({ intent, estimated_cost_usd: 10 }).expect(400);
    expect(res.body.error).toMatch(/No policy registered/);
  });

  it("honors a manual rejection from the Decision Agent", async () => {
    const { app } = await freshApp({
      "bank-b-agent:4002/decide": async () =>
        jsonResponse({ decision: "reject", reason: "flagged by risk model", errorCode: "ERR_BUDGET_EXCEEDED" }),
    });
    const { intent } = await registerProxyAAndBuildIntent(app);

    const res = await request(app).post("/accept").send({ intent, estimated_cost_usd: 10 }).expect(400);
    expect(res.body.error).toBe("flagged by risk model");
    expect(res.body.errorCode).toBe(-32002);
  });

  it("proceeds normally when the Decision Agent responds ok but does not reject", async () => {
    const { app } = await freshApp({
      "bank-b-agent:4002/decide": async () => jsonResponse({ decision: "approve", reason: "" }),
    });
    const { intent } = await registerProxyAAndBuildIntent(app);

    const res = await request(app).post("/accept").send({ intent, estimated_cost_usd: 10 }).expect(200);
    expect(res.body.acceptance?.decision).toBe("ACCEPTED");
  });

  it("falls back to the in-memory ledger's dispute pack when non-empty", async () => {
    const { app } = await freshApp();
    const { intent } = await registerProxyAAndBuildIntent(app);
    await request(app).post("/accept").send({ intent, estimated_cost_usd: 10 }).expect(200);

    const dispute = await request(app).get(`/dispute/${intent.trace_id}`).expect(200);
    expect(dispute.body.records.length).toBeGreaterThan(0);
  });

  it("falls back to the DB-backed dispute pack for an unknown trace", async () => {
    const { app } = await freshApp();
    const dispute = await request(app).get("/dispute/unknown-trace").expect(200);
    expect(dispute.body.entries).toEqual([]);
  });
});

describe("POST /reset", () => {
  it("clears envelopes and re-initializes the ProxyB gateway", async () => {
    const { app } = await freshApp();
    const { intent } = await registerProxyAAndBuildIntent(app);
    await request(app).post("/accept").send({ intent, estimated_cost_usd: 10 }).expect(200);

    await request(app).post("/reset").expect(200);
    expect((await request(app).get("/envelopes").expect(200)).body).toEqual([]);
  });
});

describe("POST /anchor", () => {
  it("proxies a successful anchor response", async () => {
    const { app } = await freshApp({ "/anchor": async () => jsonResponse({ status: "success", blockNumber: 1 }) });
    const res = await request(app).post("/anchor").expect(200);
    expect(res.body.status).toBe("success");
  });

  it("500s when the anchor service responds with a non-ok status", async () => {
    const { app } = await freshApp({ "/anchor": async () => jsonResponse({ error: "boom" }, false) });
    const res = await request(app).post("/anchor").expect(500);
    expect(res.body.error).toBe("boom");
  });

  it("500s when the anchor service is unreachable", async () => {
    const { app } = await freshApp({
      "/anchor": async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const res = await request(app).post("/anchor").expect(500);
    expect(res.body.error).toBeDefined();
  });
});

describe("GET /verify/:txHash and /verify-trace/:traceId", () => {
  it("verifies inclusion proofs for an anchored batch", async () => {
    const { app, dbPath } = await freshApp();
    seedAnchor(dbPath, "env-1", "trace-1");

    const byTx = await request(app).get("/verify/cafebabe").expect(200);
    expect(byTx.body.allValid).toBe(true);
    expect(byTx.body.leaves[0].proofValid).toBe(true);

    const byTrace = await request(app).get("/verify-trace/trace-1").expect(200);
    expect(byTrace.body.allValid).toBe(true);
    expect(byTrace.body.leaves[0].proofValid).toBe(true);
  });

  it("strips a 0x prefix from the tx hash before lookup", async () => {
    const { app, dbPath } = await freshApp();
    seedAnchor(dbPath, "env-1", "trace-1");
    const res = await request(app).get("/verify/0xcafebabe").expect(200);
    expect(res.body.txHash).toBe("0xcafebabe");
  });

  it("404s when no anchor exists for the tx hash or trace id", async () => {
    const { app } = await freshApp();
    expect((await request(app).get("/verify/0xdeadbeef").expect(404)).body.error).toBeDefined();
    expect((await request(app).get("/verify-trace/nonexistent").expect(404)).body.error).toBeDefined();
  });
});

describe("POST /executed", () => {
  it("dual-signs the execution envelope and persists an EXECUTION record", async () => {
    const { app } = await freshApp();
    const { intent } = await registerProxyAAndBuildIntent(app);
    const acceptRes = await request(app).post("/accept").send({ intent, estimated_cost_usd: 10 }).expect(200);

    const { buildExecutionEnvelope, generateKeyPair: genKey } = await import("@trustagentai/a2a-core");
    const proxyAKey = await genKey("did:workload:bank-a-proxy#key-1");
    const execution = await buildExecutionEnvelope({
      intentEnvelope: intent,
      acceptanceReceipt: acceptRes.body.acceptance,
      status: "COMPLETED",
      outputData: { ok: true },
      proxyKey: proxyAKey,
    });

    const res = await request(app).post("/executed").send({ execution }).expect(200);
    expect(res.body.execution.signatures.length).toBeGreaterThanOrEqual(2);

    const envelopes = (await request(app).get("/envelopes").expect(200)).body;
    expect(envelopes.some((e: any) => e.type === "EXECUTION")).toBe(true);
  });
});

async function seedPendingTrace(app: Express): Promise<string> {
  const { intent } = await registerProxyAAndBuildIntent(app);
  const acceptRes = await request(app).post("/accept").send({ intent, estimated_cost_usd: 10 }).expect(200);

  const { buildExecutionEnvelope, generateKeyPair: genKey } = await import("@trustagentai/a2a-core");
  const proxyAKey = await genKey("did:workload:bank-a-proxy#key-1");
  const execution = await buildExecutionEnvelope({
    intentEnvelope: intent,
    acceptanceReceipt: acceptRes.body.acceptance,
    status: "COMPLETED",
    outputData: { ok: true },
    proxyKey: proxyAKey,
  });
  await request(app).post("/executed").send({ execution }).expect(200);
  return intent.trace_id;
}

describe("POST /anchor-now", () => {
  it("no-ops when there are no pending traces", async () => {
    const { app } = await freshApp();
    const res = await request(app).post("/anchor-now").expect(200);
    expect(res.body).toEqual({ ok: true, queued: 0 });
  });

  it("queues and anchors pending traces from a completed /executed flow", async () => {
    const { app } = await freshApp({
      "/anchor": async () => jsonResponse({ status: "success", txHash: "0xabc", blockNumber: 1 }),
    });
    await seedPendingTrace(app);

    const res = await request(app).post("/anchor-now").expect(200);
    expect(res.body.queued).toBe(1);
    await sleep(20); // runAnchor() finishes in the background after the response is sent
  });

  it("logs a noop when the anchor service reports nothing pending", async () => {
    const { app } = await freshApp({ "/anchor": async () => jsonResponse({ status: "noop" }) });
    await seedPendingTrace(app);

    await request(app).post("/anchor-now").expect(200);
    await sleep(20);
  });

  it("broadcasts anchor-failed when the anchor service reports an error", async () => {
    const { app } = await freshApp({ "/anchor": async () => jsonResponse({ error: "chain congested" }, false) });
    await seedPendingTrace(app);

    await request(app).post("/anchor-now").expect(200);
    await sleep(20);
  });

  it("broadcasts anchor-failed when the anchor service is unreachable", async () => {
    const { app } = await freshApp({
      "/anchor": async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await seedPendingTrace(app);

    await request(app).post("/anchor-now").expect(200);
    await sleep(20);
  });
});
