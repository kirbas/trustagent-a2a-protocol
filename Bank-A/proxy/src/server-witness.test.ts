import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import request from "supertest";
import type { Express } from "express";
import { generateKeyPair, buildAcceptanceReceipt } from "@trustagentai/a2a-core";
import type { IntentEnvelope } from "@trustagentai/a2a-core";
import { jsonResponse, installFetch } from "./test-fetch-mock.js";

/**
 * TRUSTAGENT_URL is read once at server.ts module-load time, so exercising
 * the witness-configured branches (/reconcile success/failure) requires
 * resetting the module registry with the env var stubbed BEFORE re-import —
 * kept in its own file so it never affects server.test.ts's default (no
 * witness) module instance.
 */
const KEK = "d".repeat(64);

let buildServer: typeof import("./server.js").buildServer;
let saveEnvelope: typeof import("./db.js").saveEnvelope;

beforeAll(async () => {
  vi.stubEnv("TRUSTAGENT_URL", "http://witness.test");
  vi.resetModules();
  ({ buildServer } = await import("./server.js"));
  ({ saveEnvelope } = await import("./db.js"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function freshApp(
  handlers: Record<string, (opts?: { body?: string }) => Response | Promise<Response>> = {}
): Promise<Express> {
  installFetch(handlers, ["/register-peer-key", "/register-key"]);
  const { app } = await buildServer({
    dbPath: join(tmpdir(), `bank-a-witness-test-${randomUUID()}.db`),
    wormDbPath: join(tmpdir(), `bank-a-witness-test-worm-${randomUUID()}.db`),
    keystorePath: join(tmpdir(), `bank-a-witness-keystore-${randomUUID()}.json`),
    keystoreKek: KEK,
  });
  return app;
}

describe("POST /reconcile/:traceId (witness configured)", () => {
  it("404s when intent/acceptance rows are missing", async () => {
    const app = await freshApp();
    const res = await request(app).post("/reconcile/nonexistent-trace").expect(404);
    expect(res.body.error).toBeDefined();
  });

  it("returns alreadyReconciled when a COSIGN row already exists", async () => {
    const app = await freshApp();
    saveEnvelope("t1:intent", "INTENT", "trace-1", {}, "sig");
    saveEnvelope("t1:acceptance", "ACCEPTANCE", "trace-1", {}, "sig");
    saveEnvelope("t1:cosign", "COSIGN", "trace-1", {}, "sig");

    const res = await request(app).post("/reconcile/trace-1").expect(200);
    expect(res.body).toEqual({ ok: true, alreadyReconciled: true });
  });

  it("co-signs successfully via the witness and persists a COSIGN row", async () => {
    const app = await freshApp({
      "/co-sign": async () =>
        jsonResponse({ cosign_receipt: { envelope_type: "CoSignReceipt", signatures: [{ role: "witness" }] } }),
    });
    saveEnvelope("t2:intent", "INTENT", "trace-2", {}, "sig");
    saveEnvelope("t2:acceptance", "ACCEPTANCE", "trace-2", {}, "sig");

    const res = await request(app).post("/reconcile/trace-2").expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cosign_receipt).toBeDefined();
  });

  it("502s when the witness declines to co-sign", async () => {
    const app = await freshApp({
      "/co-sign": async () => jsonResponse({ error: "invalid handshake" }, false),
    });
    saveEnvelope("t3:intent", "INTENT", "trace-3", {}, "sig");
    saveEnvelope("t3:acceptance", "ACCEPTANCE", "trace-3", {}, "sig");

    const res = await request(app).post("/reconcile/trace-3").expect(502);
    expect(res.body.error).toBe("invalid handshake");
  });

  it("502s when the witness is unreachable", async () => {
    const app = await freshApp({
      "/co-sign": async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    saveEnvelope("t4:intent", "INTENT", "trace-4", {}, "sig");
    saveEnvelope("t4:acceptance", "ACCEPTANCE", "trace-4", {}, "sig");

    const res = await request(app).post("/reconcile/trace-4").expect(502);
    expect(res.body.error).toBeDefined();
  });
});

describe("POST /invoke (witness configured)", () => {
  it("attaches a witness co-sign receipt and broadcasts the COSIGN envelope event", async () => {
    const app = await freshApp({
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
      "/co-sign": async (opts) => {
        const body = JSON.parse(opts!.body!) as { intent: IntentEnvelope };
        return jsonResponse({
          cosign_receipt: {
            envelope_type: "CoSignReceipt",
            trace_id: body.intent.trace_id,
            signatures: [{ role: "witness" }],
          },
        });
      },
      "/executed": async () => jsonResponse({}),
    });

    const res = await request(app).post("/invoke").send({ tool: "get_document" }).expect(200);
    expect(res.body.result._a2a.cosign_receipt).toBeDefined();

    const envelopes = (await request(app).get("/envelopes").expect(200)).body;
    expect(envelopes.some((e: any) => e.type === "COSIGN")).toBe(true);
  });
});
