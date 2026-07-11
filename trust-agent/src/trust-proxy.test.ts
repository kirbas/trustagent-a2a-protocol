import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPair } from "./crypto.js";
import type { KeyPair } from "./crypto.js";
import { buildAcceptanceReceipt, buildIntentEnvelope, buildExecutionEnvelope } from "./envelopes.js";
import type { IntentEnvelope } from "./envelopes.js";
import { ProxyAGateway, ProxyBGateway } from "./trust-proxy.js";
import type { McpToolCall, PublicKeySource } from "./trust-proxy.js";
import { DegradedModeGate } from "./degraded-mode.js";
import { NonceRegistry } from "./nonce-registry.js";
import { RiskBudgetEngine, type AgentPolicy } from "./risk-budget.js";
import { DAGLedger } from "./ledger.js";

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

describe("ProxyAGateway — Proxy B accept phase", () => {
  it("returns an mcpError and does not execute when Proxy B rejects the intent", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/accept")) {
          return { ok: false, status: 400, json: async () => ({ error: "Insufficient daily budget" }) } as unknown as Response;
        }
        throw new Error(`unexpected fetch to ${url}`);
      })
    );

    const gateway = new ProxyAGateway({ proxyKey: proxyAKey, proxyBEndpoint: PROXY_B_URL });
    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await gateway.forwardToolCall(makeCall(), executeTool);

    expect(result.error?.message).toBe("Insufficient daily budget");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("returns an mcpError when Proxy B is unreachable", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    const gateway = new ProxyAGateway({ proxyKey: proxyAKey, proxyBEndpoint: PROXY_B_URL });
    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await gateway.forwardToolCall(makeCall(), executeTool);

    expect(result.error?.message).toMatch(/Proxy B unreachable/);
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe("ProxyAGateway — tool execution and Proxy B execution relay", () => {
  it("returns an mcpError when the tool itself throws", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    installFetch(proxyBKey, async () => jsonResponse({}));

    const gateway = new ProxyAGateway({ proxyKey: proxyAKey, proxyBEndpoint: PROXY_B_URL });
    const executeTool = vi.fn(async () => {
      throw new Error("tool blew up");
    });
    const result = await gateway.forwardToolCall(makeCall(), executeTool);

    expect(result.result).toBeUndefined();
    expect(result.error?.message).toBe("Tool execution failed");
  });

  it("adopts Proxy B's dual-signed execution envelope from /executed when provided", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const dualSignedStub = { fake: "dual-signed-execution-envelope" };

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
        if (u.endsWith("/executed")) return jsonResponse({ execution: dualSignedStub });
        throw new Error(`unexpected fetch to ${u}`);
      })
    );

    const gateway = new ProxyAGateway({ proxyKey: proxyAKey, proxyBEndpoint: PROXY_B_URL });
    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await gateway.forwardToolCall(makeCall(), executeTool);

    expect(result.result?._a2a?.execution_envelope).toEqual(dualSignedStub);
  });
});

describe("ProxyBGateway.handleIntent", () => {
  const DID = "did:workload:bank-a-agent";
  const TOOL = "execute_wire_transfer";

  async function makeIntent(proxyAKey: KeyPair, overrides: Partial<Parameters<typeof buildIntentEnvelope>[0]> = {}) {
    return buildIntentEnvelope({
      initiatorDid: DID,
      vcRef: "vc:test",
      targetDid: "did:workload:bank-b-proxy",
      mcpDeploymentId: "did:workload:bank-b-proxy",
      toolName: TOOL,
      toolSchemaHash: "deadbeef",
      mcpSessionId: "sess-1",
      args: { amount: 100 },
      proxyKey: proxyAKey,
      ...overrides,
    });
  }

  function makeGateway(proxyBKey: KeyPair, proxyAPublicKeys: PublicKeySource, opts: { policy?: AgentPolicy } = {}) {
    const budgetEngine = new RiskBudgetEngine();
    if (opts.policy) budgetEngine.registerPolicy(opts.policy);
    const gateway = new ProxyBGateway({
      proxyKey: proxyBKey,
      proxyAPublicKeys,
      nonceRegistry: new NonceRegistry(),
      budgetEngine,
      ledger: new DAGLedger(),
    });
    return { gateway, budgetEngine };
  }

  function keyMap(proxyAKey: KeyPair): PublicKeySource {
    return new Map([[proxyAKey.kid, proxyAKey.publicKey]]);
  }

  it("accepts a valid intent within budget and records it in the ledger", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const { envelope: intent } = await makeIntent(proxyAKey);
    const { gateway } = makeGateway(proxyBKey, keyMap(proxyAKey), {
      policy: { did: DID, maxSingleActionUsd: 1000, dailyBudgetUsd: 1000, allowedTools: ["*"] },
    });

    const result = await gateway.handleIntent(intent, 50);

    expect(result.error).toBeUndefined();
    expect(result.acceptance?.decision).toBe("ACCEPTED");
  });

  it("denies via manualRejection without running any other checks", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const { envelope: intent } = await makeIntent(proxyAKey);
    const { gateway } = makeGateway(proxyBKey, keyMap(proxyAKey));

    const result = await gateway.handleIntent(intent, 50, { reason: "policy hold", errorCode: -32099 });

    expect(result.error).toBe("policy hold");
    expect(result.errorCode).toBe(-32099);
    expect(result.denial?.decision).toBe("REJECTED");
  });

  it("denies an expired intent", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const { envelope: intent } = await makeIntent(proxyAKey, { ttlSeconds: -60 });
    const { gateway } = makeGateway(proxyBKey, keyMap(proxyAKey), {
      policy: { did: DID, maxSingleActionUsd: 1000, dailyBudgetUsd: 1000, allowedTools: ["*"] },
    });

    const result = await gateway.handleIntent(intent, 50);

    expect(result.error).toMatch(/expired/);
  });

  it("denies a replayed intent (same initiator + nonce twice)", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const { envelope: intent } = await makeIntent(proxyAKey);
    const { gateway } = makeGateway(proxyBKey, keyMap(proxyAKey), {
      policy: { did: DID, maxSingleActionUsd: 1000, dailyBudgetUsd: 1000, allowedTools: ["*"] },
    });

    await gateway.handleIntent(intent, 50);
    const result = await gateway.handleIntent(intent, 50);

    expect(result.error).toMatch(/Replay detected/);
  });

  it("denies an intent missing a proxy signature", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const { envelope: baseIntent } = await makeIntent(proxyAKey);
    const intent = { ...baseIntent, signatures: [] };
    const { gateway } = makeGateway(proxyBKey, keyMap(proxyAKey), {
      policy: { did: DID, maxSingleActionUsd: 1000, dailyBudgetUsd: 1000, allowedTools: ["*"] },
    });

    const result = await gateway.handleIntent(intent, 50);

    expect(result.error).toMatch(/Missing proxy signature/);
  });

  it("denies an intent signed by an unregistered key id", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const { envelope: intent } = await makeIntent(proxyAKey);
    const { gateway } = makeGateway(proxyBKey, new Map(), {
      policy: { did: DID, maxSingleActionUsd: 1000, dailyBudgetUsd: 1000, allowedTools: ["*"] },
    });

    const result = await gateway.handleIntent(intent, 50);

    expect(result.error).toMatch(/Unknown key id/);
  });

  it("denies a tampered intent (signature no longer verifies)", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const { envelope: baseIntent } = await makeIntent(proxyAKey);
    const intent = { ...baseIntent, payload: { ...baseIntent.payload, args_hash: "tampered" } };
    const { gateway } = makeGateway(proxyBKey, keyMap(proxyAKey), {
      policy: { did: DID, maxSingleActionUsd: 1000, dailyBudgetUsd: 1000, allowedTools: ["*"] },
    });

    const result = await gateway.handleIntent(intent, 50);

    expect(result.error).toMatch(/Signature verification failed/);
  });

  it("denies when the risk budget engine rejects the call", async () => {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const { envelope: intent } = await makeIntent(proxyAKey);
    const { gateway } = makeGateway(proxyBKey, keyMap(proxyAKey), {
      policy: { did: DID, maxSingleActionUsd: 10, dailyBudgetUsd: 1000, allowedTools: ["*"] },
    });

    const result = await gateway.handleIntent(intent, 500);

    expect(result.errorCode).toBe(-32002);
    expect(result.error).toMatch(/exceeds single-action cap/);
  });
});

describe("ProxyBGateway.handleExecution", () => {
  const DID = "did:workload:bank-a-agent";

  async function acceptedFlow() {
    const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
    const budgetEngine = new RiskBudgetEngine();
    budgetEngine.registerPolicy({ did: DID, maxSingleActionUsd: 1000, dailyBudgetUsd: 1000, allowedTools: ["*"] });
    const ledger = new DAGLedger();
    const gateway = new ProxyBGateway({
      proxyKey: proxyBKey,
      proxyAPublicKeys: new Map([[proxyAKey.kid, proxyAKey.publicKey]]),
      nonceRegistry: new NonceRegistry(),
      budgetEngine,
      ledger,
    });

    const { envelope: intent } = await buildIntentEnvelope({
      initiatorDid: DID,
      vcRef: "vc:test",
      targetDid: "did:workload:bank-b-proxy",
      mcpDeploymentId: "did:workload:bank-b-proxy",
      toolName: "execute_wire_transfer",
      toolSchemaHash: "deadbeef",
      mcpSessionId: "sess-1",
      args: { amount: 100 },
      proxyKey: proxyAKey,
    });
    const acceptResult = await gateway.handleIntent(intent, 50);
    const execution = await buildExecutionEnvelope({
      intentEnvelope: intent,
      acceptanceReceipt: acceptResult.acceptance!,
      status: "COMPLETED",
      outputData: { ok: true },
      proxyKey: proxyAKey,
    });
    return { gateway, budgetEngine, ledger, execution };
  }

  it("counter-signs the execution envelope (dual-sign, D1)", async () => {
    const { gateway, execution } = await acceptedFlow();
    const dualSigned = await gateway.handleExecution(execution);
    expect(dualSigned.signatures).toHaveLength(2);
    expect(dualSigned.signatures[1].role).toBe("proxy");
  });

  it("records spend and persists an EXECUTION_RECORD when status is COMPLETED", async () => {
    const { gateway, budgetEngine, ledger, execution } = await acceptedFlow();
    const spy = vi.spyOn(budgetEngine, "recordSpend");

    const dualSigned = await gateway.handleExecution(execution);

    expect(spy).toHaveBeenCalledWith(DID, 50);
    const history = ledger.getHistory(execution.trace_id);
    expect(history.some((r) => r.event_type === "EXECUTION_RECORD")).toBe(true);
    expect(dualSigned.trace_id).toBe(execution.trace_id);
  });

  it("does not record spend when status is FAILED", async () => {
    const { gateway, budgetEngine, execution } = await acceptedFlow();
    const spy = vi.spyOn(budgetEngine, "recordSpend");
    const failed = { ...execution, status: "FAILED" as const };

    await gateway.handleExecution(failed);

    expect(spy).not.toHaveBeenCalled();
  });

  it("cleans up per-transaction metadata so a second call for the same trace does not re-record spend", async () => {
    const { gateway, budgetEngine, execution } = await acceptedFlow();
    const spy = vi.spyOn(budgetEngine, "recordSpend");

    await gateway.handleExecution(execution);
    await gateway.handleExecution(execution); // trace_id metadata already cleaned up

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
