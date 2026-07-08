import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPair } from "./crypto.js";
import type { KeyPair } from "./crypto.js";
import { buildAcceptanceReceipt } from "./envelopes.js";
import type { IntentEnvelope } from "./envelopes.js";
import { ProxyAGateway } from "./trust-proxy.js";
import type { McpToolCall } from "./trust-proxy.js";
import { DegradedModeGate } from "./degraded-mode.js";

const WITNESS_URL = "http://witness.test";
const PROXY_B_URL = "http://proxy-b.test";

function makeCall(): McpToolCall {
  return {
    jsonrpc: "2.0",
    id: "call-1",
    method: "tools/call",
    params: {
      name: "execute_wire_transfer",
      arguments: { amount: 100 },
      _initiator_did: "did:workload:bank-a-agent",
      _vc_ref: "vc:test",
      _mcp_deployment_id: "did:workload:bank-b-proxy",
      _tool_schema_hash: "deadbeef",
      _mcp_session_id: "sess-1",
    },
  };
}

/** JSON fetch Response stub. */
function jsonResponse(obj: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 503, json: async () => obj } as unknown as Response;
}

/**
 * Install a fetch mock. `/accept` builds a real acceptance from the posted
 * intent (signed by proxyB); `/co-sign` is delegated to `coSign`; `/executed`
 * echoes back nothing so Proxy A keeps its own execution envelope.
 */
function installFetch(
  proxyBKey: KeyPair,
  coSign: (intent: IntentEnvelope) => Promise<Response>
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts?: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/accept")) {
        const body = JSON.parse(opts!.body!) as { intent: IntentEnvelope };
        const acceptance = await buildAcceptanceReceipt({
          intentEnvelope: body.intent,
          policyEvalInput: { decision: "ACCEPTED" },
          proxyKey: proxyBKey,
        });
        return jsonResponse({ acceptance });
      }
      if (u.endsWith("/co-sign")) {
        const body = JSON.parse(opts!.body!) as { intent: IntentEnvelope };
        return coSign(body.intent);
      }
      if (u.endsWith("/executed")) return jsonResponse({});
      throw new Error(`unexpected fetch to ${u}`);
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ProxyAGateway witness finality gate", () => {
  it("finalizes with a co-sign receipt attached when the witness co-signs", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");

    installFetch(proxyBKey, async (intent) =>
      jsonResponse({
        cosign_receipt: {
          envelope_type: "CoSignReceipt",
          trace_id: intent.trace_id,
          signatures: [{ role: "witness", kid: "witness#1" }],
        },
        seq: 0,
        prev_hash: "0".repeat(64),
      })
    );

    const gateway = new ProxyAGateway({
      proxyKey: proxyAKey,
      proxyBEndpoint: PROXY_B_URL,
      witnessEndpoint: WITNESS_URL,
    });

    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await gateway.forwardToolCall(makeCall(), executeTool);

    expect(result.error).toBeUndefined();
    expect(executeTool).toHaveBeenCalledOnce();
    expect(result.result?._a2a?.cosign_receipt).toBeDefined();
    expect(result.result?._a2a?.cosign_receipt?.envelope_type).toBe("CoSignReceipt");
  });

  it("does NOT finalize and does NOT execute the tool when the witness rejects", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");

    installFetch(proxyBKey, async () => jsonResponse({ error: "invalid handshake" }, false));

    const gateway = new ProxyAGateway({
      proxyKey: proxyAKey,
      proxyBEndpoint: PROXY_B_URL,
      witnessEndpoint: WITNESS_URL,
    });

    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await gateway.forwardToolCall(makeCall(), executeTool);

    expect(result.result).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("does NOT finalize when the witness is unreachable (fetch throws)", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");

    installFetch(proxyBKey, async () => {
      throw new Error("ECONNREFUSED");
    });

    const gateway = new ProxyAGateway({
      proxyKey: proxyAKey,
      proxyBEndpoint: PROXY_B_URL,
      witnessEndpoint: WITNESS_URL,
    });

    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await gateway.forwardToolCall(makeCall(), executeTool);

    expect(result.error).toBeDefined();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("stays backward compatible: no witness configured → completes without co-sign", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");

    installFetch(proxyBKey, async () => {
      throw new Error("witness should not be called");
    });

    const gateway = new ProxyAGateway({
      proxyKey: proxyAKey,
      proxyBEndpoint: PROXY_B_URL,
    });

    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await gateway.forwardToolCall(makeCall(), executeTool);

    expect(result.error).toBeUndefined();
    expect(executeTool).toHaveBeenCalledOnce();
    expect(result.result?._a2a?.cosign_receipt).toBeUndefined();
  });
});

describe("ProxyAGateway degraded-mode fallback (Delta #7)", () => {
  it("completes with a degraded_record when the witness is unreachable and the gate allows it", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");

    installFetch(proxyBKey, async () => {
      throw new Error("ECONNREFUSED");
    });

    const gateway = new ProxyAGateway({
      proxyKey: proxyAKey,
      proxyBEndpoint: PROXY_B_URL,
      witnessEndpoint: WITNESS_URL,
      degradedMode: new DegradedModeGate({
        maxValueUsd: 1000,
        maxDegradedPerWindow: 5,
        windowSeconds: 60,
        reconciliationSeconds: 300,
      }),
    });

    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await gateway.forwardToolCall(makeCall(), executeTool);

    expect(result.error).toBeUndefined();
    expect(executeTool).toHaveBeenCalledOnce();
    expect(result.result?._a2a?.cosign_receipt).toBeUndefined();
    expect(result.result?._a2a?.degraded_record).toMatchObject({ reason: expect.stringContaining("unreachable") });
    expect(result.result?._a2a?.degraded_record?.reconcile_by).toBeDefined();
  });

  it("still hard-fails when the degraded-mode gate refuses (e.g. value cap)", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");

    installFetch(proxyBKey, async () => {
      throw new Error("ECONNREFUSED");
    });

    const gateway = new ProxyAGateway({
      proxyKey: proxyAKey,
      proxyBEndpoint: PROXY_B_URL,
      witnessEndpoint: WITNESS_URL,
      degradedMode: new DegradedModeGate({
        maxValueUsd: 0, // any positive-cost call is capped out
        maxDegradedPerWindow: 5,
        windowSeconds: 60,
        reconciliationSeconds: 300,
      }),
    });

    const call = makeCall();
    call.params._estimated_cost_usd = 100;
    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await gateway.forwardToolCall(call, executeTool);

    expect(result.error).toBeDefined();
    expect(executeTool).not.toHaveBeenCalled();
  });
});
