import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import request from "supertest";
import type { Express } from "express";
import { generateKeyPair, buildAcceptanceReceipt } from "@trustagentai/a2a-core";
import type { IntentEnvelope } from "@trustagentai/a2a-core";
import { buildServer } from "./server.js";
import { jsonResponse, installFetch } from "./test-fetch-mock.js";

const KEK = "c".repeat(64);

async function freshApp(
  handlers: Record<string, (opts?: { body?: string }) => Response | Promise<Response>> = {}
): Promise<Express> {
  installFetch(handlers);
  const { app } = await buildServer({
    dbPath: join(tmpdir(), `bank-a-server-test-${randomUUID()}.db`),
    wormDbPath: join(tmpdir(), `bank-a-server-test-worm-${randomUUID()}.db`),
    keystorePath: join(tmpdir(), `bank-a-server-keystore-${randomUUID()}.json`),
    keystoreKek: KEK,
  });
  return app;
}

afterEach(() => vi.unstubAllGlobals());

describe("buildServer content-KEK validation", () => {
  afterEach(() => {
    delete process.env.BANK_A_CONTENT_KEK;
  });

  it("throws when a content KEK env var is not 64 hex characters", async () => {
    installFetch();
    process.env.BANK_A_CONTENT_KEK = "not-valid-hex";
    await expect(
      buildServer({
        dbPath: join(tmpdir(), `bank-a-server-test-${randomUUID()}.db`),
        wormDbPath: join(tmpdir(), `bank-a-server-test-worm-${randomUUID()}.db`),
        keystorePath: join(tmpdir(), `bank-a-server-keystore-${randomUUID()}.json`),
        keystoreKek: KEK,
      })
    ).rejects.toThrow(/must be 64 hex characters/);
  });
});

describe("GET /health", () => {
  it("reports ok", async () => {
    const app = await freshApp();
    const res = await request(app).get("/health").expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("trigger / reset lifecycle", () => {
  it("tracks the triggered flag across /trigger, /trigger-status, /trigger-done", async () => {
    const app = await freshApp();
    expect((await request(app).get("/trigger-status").expect(200)).body).toEqual({ triggered: false });

    await request(app).post("/trigger").expect(200);
    expect((await request(app).get("/trigger-status").expect(200)).body).toEqual({ triggered: true });

    await request(app).post("/trigger-done").expect(200);
    expect((await request(app).get("/trigger-status").expect(200)).body).toEqual({ triggered: false });
  });

  it("clears envelopes and resets the triggered flag on /reset", async () => {
    const app = await freshApp();
    await request(app).post("/trigger").expect(200);

    await request(app).post("/reset").expect(200);
    expect((await request(app).get("/trigger-status").expect(200)).body).toEqual({ triggered: false });
    expect((await request(app).get("/envelopes").expect(200)).body).toEqual([]);
  });
});

describe("POST /thought", () => {
  it("persists a thought and returns it via GET /thoughts", async () => {
    const app = await freshApp();
    await request(app).post("/thought").send({ source: "bank-a", text: "hello" }).expect(200);
    const res = await request(app).get("/thoughts").expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ source: "bank-a", text: "hello" });
  });
});

describe("GET /verify-chain", () => {
  it("reports a valid empty chain", async () => {
    const app = await freshApp();
    const res = await request(app).get("/verify-chain").expect(200);
    expect(res.body.valid).toBe(true);
  });
});

describe("POST /invoke", () => {
  it("completes end-to-end with a mocked Proxy B and persists all envelope types", async () => {
    installFetch({
      "/accept": async (opts) => {
        const body = JSON.parse(opts!.body!) as { intent: IntentEnvelope };
        const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
        const acceptance = await buildAcceptanceReceipt({
          intentEnvelope: body.intent,
          policyEvalInput: { decision: "ACCEPTED" },
          proxyKey: proxyBKey,
        });
        return jsonResponse({ acceptance });
      },
      "/executed": async () => jsonResponse({}),
    });

    const { app } = await buildServer({
      dbPath: join(tmpdir(), `bank-a-server-test-${randomUUID()}.db`),
      wormDbPath: join(tmpdir(), `bank-a-server-test-worm-${randomUUID()}.db`),
      keystorePath: join(tmpdir(), `bank-a-server-keystore-${randomUUID()}.json`),
      keystoreKek: KEK,
    });

    const res = await request(app)
      .post("/invoke")
      .send({ tool: "get_security_report", args: { q: 1 }, cost: 10 })
      .expect(200);

    expect(res.body.result._a2a.intent_envelope).toBeDefined();
    expect(res.body.result._a2a.acceptance_receipt).toBeDefined();
    expect(res.body.result._a2a.execution_envelope).toBeDefined();

    const envelopes = (await request(app).get("/envelopes").expect(200)).body;
    const types = envelopes.map((e: any) => e.type).sort();
    expect(types).toEqual(["ACCEPTANCE", "EXECUTION", "INTENT", "PROVENANCE"]);
  });

  it("re-registers and retries once when Proxy B reports an unknown key", async () => {
    let acceptCalls = 0;
    installFetch({
      "/accept": async (opts) => {
        acceptCalls++;
        if (acceptCalls === 1) {
          return jsonResponse({ error: "Unknown key id: did:workload:bank-a-proxy#key-1" }, false);
        }
        const body = JSON.parse(opts!.body!) as { intent: IntentEnvelope };
        const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
        const acceptance = await buildAcceptanceReceipt({
          intentEnvelope: body.intent,
          policyEvalInput: { decision: "ACCEPTED" },
          proxyKey: proxyBKey,
        });
        return jsonResponse({ acceptance });
      },
      "/executed": async () => jsonResponse({}),
      "/register-peer-key": async () => jsonResponse({ ok: true }),
    });

    const { app } = await buildServer({
      dbPath: join(tmpdir(), `bank-a-server-test-${randomUUID()}.db`),
      wormDbPath: join(tmpdir(), `bank-a-server-test-worm-${randomUUID()}.db`),
      keystorePath: join(tmpdir(), `bank-a-server-keystore-${randomUUID()}.json`),
      keystoreKek: KEK,
    });

    const res = await request(app).post("/invoke").send({ tool: "get_document" }).expect(200);
    expect(acceptCalls).toBe(2);
    expect(res.body.result._a2a.intent_envelope).toBeDefined();
  });

  it("returns a 400 mcp error when Proxy B rejects the intent", async () => {
    const app = await freshApp({
      "/accept": async () => jsonResponse({ error: "Insufficient daily budget" }, false),
    });
    const res = await request(app).post("/invoke").send({ tool: "execute_wire_transfer", cost: 999999 }).expect(400);
    expect(res.body.error?.message).toBe("Insufficient daily budget");
  });
});

describe("GET /degraded-status/:traceId", () => {
  it("404s when there is no degraded record for the trace", async () => {
    const app = await freshApp();
    const res = await request(app).get("/degraded-status/nonexistent").expect(404);
    expect(res.body.error).toBeDefined();
  });
});

describe("POST /reconcile/:traceId", () => {
  it("400s when no witness is configured", async () => {
    const app = await freshApp();
    const res = await request(app).post("/reconcile/some-trace").expect(400);
    expect(res.body.error).toBe("no witness configured");
  });
});

describe("POST /cross-check", () => {
  it("400s when traceId is missing", async () => {
    const app = await freshApp();
    const res = await request(app).post("/cross-check").send({}).expect(400);
    expect(res.body.error).toBe("traceId required");
  });

  it("500s when Proxy B is unreachable for the cross-check", async () => {
    const app = await freshApp({
      "/envelopes-by-trace/trace-1": async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const res = await request(app).post("/cross-check").send({ traceId: "trace-1" }).expect(500);
    expect(res.body.error).toBeDefined();
  });

  it("500s when Proxy B responds with a non-ok status", async () => {
    const app = await freshApp({
      "/envelopes-by-trace/trace-1": async () => jsonResponse({ error: "db down" }, false),
    });
    const res = await request(app).post("/cross-check").send({ traceId: "trace-1" }).expect(500);
    expect(res.body.error).toMatch(/Proxy B returned/);
  });

  it("reports synced=true when local and remote envelopes and anchor match", async () => {
    const app = await freshApp({
      "/envelopes-by-trace/trace-1": async () => jsonResponse([]),
      "/verify-trace/trace-1": async () => jsonResponse({ ok: true, allValid: true, blockNumber: 42 }),
    });
    const res = await request(app).post("/cross-check").send({ traceId: "trace-1" }).expect(200);
    expect(res.body.synced).toBe(true);
    expect(res.body.details.some((d: any) => d.type === "MERKLE_ANCHOR" && d.match)).toBe(true);
  });

  it("verifies the causal chain and reports synced=true when remote mirrors local exactly", async () => {
    let localTraceId = "";
    const app = await freshApp({
      "/accept": async (opts) => {
        const body = JSON.parse(opts!.body!) as { intent: IntentEnvelope };
        localTraceId = body.intent.trace_id;
        const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
        const acceptance = await buildAcceptanceReceipt({
          intentEnvelope: body.intent,
          policyEvalInput: { decision: "ACCEPTED" },
          proxyKey: proxyBKey,
        });
        return jsonResponse({ acceptance });
      },
      "/executed": async () => jsonResponse({}),
    });

    await request(app).post("/invoke").send({ tool: "get_document" }).expect(200);
    const localEnvelopes = (await request(app).get("/envelopes").expect(200)).body as Array<{
      type: string;
      raw_payload: string;
      signature: string;
    }>;

    installFetch({
      [`/envelopes-by-trace/${encodeURIComponent(localTraceId)}`]: async () => jsonResponse(localEnvelopes),
      [`/verify-trace/${encodeURIComponent(localTraceId)}`]: async () => jsonResponse({ ok: true, allValid: true, blockNumber: 1 }),
    });

    const res = await request(app).post("/cross-check").send({ traceId: localTraceId }).expect(200);
    expect(res.body.synced).toBe(true);
    const causal = res.body.details.find((d: any) => d.type === "CAUSAL_CHAIN");
    expect(causal.match).toBe(true);
  });

  it("reports a payload mismatch when remote content differs from local", async () => {
    let localTraceId = "";
    const app = await freshApp({
      "/accept": async (opts) => {
        const body = JSON.parse(opts!.body!) as { intent: IntentEnvelope };
        localTraceId = body.intent.trace_id;
        const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
        const acceptance = await buildAcceptanceReceipt({
          intentEnvelope: body.intent,
          policyEvalInput: { decision: "ACCEPTED" },
          proxyKey: proxyBKey,
        });
        return jsonResponse({ acceptance });
      },
      "/executed": async () => jsonResponse({}),
    });

    await request(app).post("/invoke").send({ tool: "get_document" }).expect(200);

    installFetch({
      [`/envelopes-by-trace/${encodeURIComponent(localTraceId)}`]: async () =>
        jsonResponse([{ type: "INTENT", raw_payload: JSON.stringify({ tampered: true }), signature: "sig" }]),
      [`/verify-trace/${encodeURIComponent(localTraceId)}`]: async () => jsonResponse({ ok: false, error: "not anchored yet" }),
    });

    const res = await request(app).post("/cross-check").send({ traceId: localTraceId }).expect(200);
    expect(res.body.synced).toBe(false);
    const intentDetail = res.body.details.find((d: any) => d.type === "INTENT");
    expect(intentDetail.match).toBe(false);
    expect(intentDetail.reason).toMatch(/Payload mismatch/);
  });
});
