/**
 * TrustAgentAI — Trust Proxy (MCP Middleware)
 *
 * Intercepts MCP JSON-RPC tool_call requests and enforces the A2A protocol:
 *
 *   INBOUND  (Proxy A side — the initiating agent):
 *     1. Receive MCP tool_call from Agent A
 *     2. Build & sign IntentEnvelope
 *     3. Forward envelope to Proxy B
 *     4. Receive AcceptanceReceipt, verify it
 *     5. Allow the actual MCP call to proceed
 *     6. Receive result, forward ExecutionEnvelope back
 *
 *   OUTBOUND (Proxy B side — the executing agent/MCP server):
 *     1. Receive IntentEnvelope from Proxy A
 *     2. Check nonce (anti-replay)
 *     3. Check TTL (expiry)
 *     4. Verify Proxy A signature
 *     5. Check risk budget (D4)
 *     6. Sign & return AcceptanceReceipt
 *     7. After execution: sign & return ExecutionEnvelope
 *
 * Transport: The proxy communicates over HTTP/JSON (easily adaptable to
 * WebSockets or stdio for native MCP transport).
 *
 * This file is the CORE LOGIC. The HTTP server wrapper is in proxy-server.ts.
 */

import { KeyPair, verifySignature } from "./crypto.js";
import {
  buildIntentEnvelope,
  buildAcceptanceReceipt,
  buildExecutionEnvelope,
  IntentEnvelope,
  AcceptanceReceipt,
  ExecutionEnvelope,
} from "./envelopes.js";
import { DAGLedger } from "./ledger.js";
import { NonceRegistry } from "./nonce-registry.js";
import { RiskBudgetEngine } from "./risk-budget.js";

// ─── MCP JSON-RPC types (minimal subset) ──────────────────────────────────────

export interface McpToolCall {
  jsonrpc: "2.0";
  id: string | number;
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
    /** Injected by Proxy A: DID of the calling agent */
    _initiator_did: string;
    /** Injected by Proxy A: VC reference */
    _vc_ref: string;
    /** Injected by Proxy A: MCP deployment identifier */
    _mcp_deployment_id: string;
    /** Injected by Proxy A: schema hash of the tool */
    _tool_schema_hash: string;
    /** Injected by Proxy A: session ID */
    _mcp_session_id: string;
    /** Injected by Proxy A: estimated cost in USD (for budget check) */
    _estimated_cost_usd?: number;
  };
}

export interface McpToolResult {
  jsonrpc: "2.0";
  id: string | number;
  result?: {
    content: Array<{ type: string; text: string }>;
    _a2a?: {
      intent_envelope: IntentEnvelope;
      acceptance_receipt: AcceptanceReceipt;
      execution_envelope: ExecutionEnvelope;
    };
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// MCP error codes
const ERR_UNAUTHORIZED = -32001;
const ERR_BUDGET_EXCEEDED = -32002;
const ERR_REPLAY = -32003;
const ERR_EXPIRED = -32004;
const ERR_INVALID_SIGNATURE = -32005;

// ─── Proxy A (Initiator Side) ─────────────────────────────────────────────────

export interface ProxyAConfig {
  proxyKey: KeyPair;
  agentKey?: KeyPair;         // for Dual-Sign
  attestationRef?: string;
  proxyBEndpoint: string;     // URL of Proxy B's /accept endpoint
  ttlSeconds?: number;
}

/**
 * ProxyA wraps an outgoing MCP tool_call.
 * It builds the IntentEnvelope, sends it to Proxy B for acceptance,
 * and if accepted, allows the call to proceed.
 *
 * Usage:
 *   const proxyA = new ProxyAGateway(config);
 *   const result = await proxyA.forwardToolCall(mcpCall, executeToolFn);
 */
export class ProxyAGateway {
  constructor(private cfg: ProxyAConfig) {}

  async forwardToolCall(
    call: McpToolCall,
    /**
     * The actual function that executes the MCP tool and returns raw output.
     * Proxy A calls this only after Proxy B has accepted.
     */
    executeTool: (call: McpToolCall) => Promise<unknown>
  ): Promise<McpToolResult> {
    const p = call.params;

    // 1. Build IntentEnvelope
    const { envelope: intentEnv } = await buildIntentEnvelope({
      initiatorDid: p._initiator_did,
      vcRef: p._vc_ref,
      targetDid: p._mcp_deployment_id,
      mcpDeploymentId: p._mcp_deployment_id,
      toolName: p.name,
      toolSchemaHash: p._tool_schema_hash,
      mcpSessionId: p._mcp_session_id,
      args: p.arguments,
      ttlSeconds: this.cfg.ttlSeconds,
      proxyKey: this.cfg.proxyKey,
      agentKey: this.cfg.agentKey,
      attestationRef: this.cfg.attestationRef,
    });

    // 2. Send IntentEnvelope to Proxy B → get AcceptanceReceipt
    let acceptance: AcceptanceReceipt;
    try {
      const resp = await fetch(`${this.cfg.proxyBEndpoint}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: intentEnv, estimated_cost_usd: p._estimated_cost_usd }),
      });
      const body = await resp.json() as { acceptance?: AcceptanceReceipt; error?: string };
      if (!resp.ok || !body.acceptance) {
        return this._mcpError(call.id, ERR_UNAUTHORIZED, body.error ?? "Proxy B rejected intent");
      }
      acceptance = body.acceptance;
    } catch (err) {
      return this._mcpError(call.id, ERR_UNAUTHORIZED, `Proxy B unreachable: ${err}`);
    }

    // 3. Execute the actual tool
    let outputData: unknown;
    let status: "COMPLETED" | "FAILED" = "COMPLETED";
    try {
      outputData = await executeTool(call);
    } catch (err) {
      status = "FAILED";
      outputData = { error: String(err) };
    }

    // 4. Build ExecutionEnvelope
    const executionEnv = await buildExecutionEnvelope({
      intentEnvelope: intentEnv,
      acceptanceReceipt: acceptance,
      status,
      outputData,
      proxyKey: this.cfg.proxyKey,
    });

    // 5. Notify Proxy B of execution result (fire-and-forget for latency)
    fetch(`${this.cfg.proxyBEndpoint}/executed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution: executionEnv }),
    }).catch(() => {}); // best-effort

    if (status === "FAILED") {
      return this._mcpError(call.id, -32000, "Tool execution failed");
    }

    return {
      jsonrpc: "2.0",
      id: call.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(outputData) }],
        _a2a: { intent_envelope: intentEnv, acceptance_receipt: acceptance, execution_envelope: executionEnv },
      },
    };
  }

  private _mcpError(id: string | number, code: number, message: string): McpToolResult {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
}

// ─── Proxy B (Executor Side) ──────────────────────────────────────────────────

export interface ProxyBConfig {
  proxyKey: KeyPair;
  proxyAPublicKeys: Map<string, Uint8Array>; // kid → publicKey
  nonceRegistry: NonceRegistry;
  budgetEngine: RiskBudgetEngine;
  ledger: DAGLedger;
  ttlSeconds?: number;
}

export interface AcceptResult {
  acceptance?: AcceptanceReceipt;
  error?: string;
  errorCode?: number;
}

/**
 * ProxyB validates an incoming IntentEnvelope and — if all checks pass —
 * returns a signed AcceptanceReceipt.
 */
export class ProxyBGateway {
  private intentEntryHashes = new Map<string, string>(); // trace_id → entry_hash
  // Store per-transaction metadata needed at execution time
  private intentMeta = new Map<string, { initiatorDid: string; estimatedCostUsd: number }>();

  constructor(private cfg: ProxyBConfig) {}

  async handleIntent(
    intent: IntentEnvelope,
    estimatedCostUsd = 0
  ): Promise<AcceptResult> {

    // 1. TTL check
    if (!this.cfg.nonceRegistry.checkExpiry(intent.expires_at)) {
      return { error: "Intent envelope has expired", errorCode: ERR_EXPIRED };
    }

    // 2. Anti-replay nonce check
    const consumed = this.cfg.nonceRegistry.consume(
      intent.initiator.did,
      intent.payload.nonce,
      intent.expires_at
    );
    if (!consumed) {
      return { error: "Replay detected: nonce already seen", errorCode: ERR_REPLAY };
    }

    // 3. Verify Proxy A signature
    const proxySig = intent.signatures.find((s) => s.role === "proxy");
    if (!proxySig) {
      return { error: "Missing proxy signature in intent", errorCode: ERR_INVALID_SIGNATURE };
    }
    const pubKey = this.cfg.proxyAPublicKeys.get(proxySig.kid);
    if (!pubKey) {
      return { error: `Unknown key id: ${proxySig.kid}`, errorCode: ERR_INVALID_SIGNATURE };
    }
    try {
      await verifySignature(intent as unknown as Record<string, unknown>, proxySig, pubKey);
    } catch (e) {
      return { error: `Signature verification failed: ${e}`, errorCode: ERR_INVALID_SIGNATURE };
    }

    // 4. Risk budget check (D4)
    const budgetResult = this.cfg.budgetEngine.check(
      intent.initiator.did,
      intent.target.tool_name,
      estimatedCostUsd
    );
    if (!budgetResult.allowed) {
      return { error: budgetResult.reason, errorCode: ERR_BUDGET_EXCEEDED };
    }

    // 5. Record Intent in DAG ledger
    const intentEntry = this.cfg.ledger.append("INTENT_RECORD", intent);
    this.intentEntryHashes.set(intent.trace_id, intentEntry.entry_hash);

    // 6. Build & sign AcceptanceReceipt
    const policyEval = {
      vc_ref: intent.initiator.vc_ref,
      tool: intent.target.tool_name,
      estimated_cost_usd: estimatedCostUsd,
      budget_remaining_usd: budgetResult.remainingDailyUsd,
      decision: "ACCEPTED",
    };

    const acceptance = await buildAcceptanceReceipt({
      intentEnvelope: intent,
      policyEvalInput: policyEval,
      ttlSeconds: this.cfg.ttlSeconds,
      proxyKey: this.cfg.proxyKey,
    });

    // 7. Record Acceptance in DAG
    const prevHash = this.intentEntryHashes.get(intent.trace_id);
    this.cfg.ledger.append("ACCEPTANCE_RECORD", acceptance, prevHash ? [prevHash] : []);

    // 8. Store metadata for recordSpend at execution time
    this.intentMeta.set(intent.trace_id, {
      initiatorDid: intent.initiator.did,
      estimatedCostUsd: estimatedCostUsd,
    });

    return { acceptance };
  }

  async handleExecution(execution: ExecutionEnvelope): Promise<void> {
    const intentHash = this.intentEntryHashes.get(execution.trace_id);
    this.cfg.ledger.append(
      "EXECUTION_RECORD",
      execution,
      intentHash ? [intentHash] : []
    );

    // D4: Record actual spend only on successful execution
    if (execution.status === "COMPLETED") {
      const meta = this.intentMeta.get(execution.trace_id);
      if (meta) {
        this.cfg.budgetEngine.recordSpend(meta.initiatorDid, meta.estimatedCostUsd);
      }
    }

    // Clean up stored metadata — transaction lifecycle is complete
    this.intentMeta.delete(execution.trace_id);
    this.intentEntryHashes.delete(execution.trace_id);
  }
}
