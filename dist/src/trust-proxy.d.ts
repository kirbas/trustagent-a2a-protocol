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
import { KeyPair } from "./crypto.js";
import { IntentEnvelope, AcceptanceReceipt, ExecutionEnvelope } from "./envelopes.js";
import { DAGLedger } from "./ledger.js";
import { NonceRegistry } from "./nonce-registry.js";
import { RiskBudgetEngine } from "./risk-budget.js";
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
        content: Array<{
            type: string;
            text: string;
        }>;
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
export interface ProxyAConfig {
    proxyKey: KeyPair;
    agentKey?: KeyPair;
    attestationRef?: string;
    proxyBEndpoint: string;
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
export declare class ProxyAGateway {
    private cfg;
    constructor(cfg: ProxyAConfig);
    forwardToolCall(call: McpToolCall, 
    /**
     * The actual function that executes the MCP tool and returns raw output.
     * Proxy A calls this only after Proxy B has accepted.
     */
    executeTool: (call: McpToolCall) => Promise<unknown>): Promise<McpToolResult>;
    private _mcpError;
}
export interface ProxyBConfig {
    proxyKey: KeyPair;
    proxyAPublicKeys: Map<string, Uint8Array>;
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
export declare class ProxyBGateway {
    private cfg;
    private intentEntryHashes;
    constructor(cfg: ProxyBConfig);
    handleIntent(intent: IntentEnvelope, estimatedCostUsd?: number): Promise<AcceptResult>;
    handleExecution(execution: ExecutionEnvelope): Promise<void>;
}
//# sourceMappingURL=trust-proxy.d.ts.map