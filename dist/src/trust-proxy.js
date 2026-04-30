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
import { verifySignature } from "./crypto.js";
import { buildIntentEnvelope, buildAcceptanceReceipt, buildExecutionEnvelope, } from "./envelopes.js";
// MCP error codes
const ERR_UNAUTHORIZED = -32001;
const ERR_BUDGET_EXCEEDED = -32002;
const ERR_REPLAY = -32003;
const ERR_EXPIRED = -32004;
const ERR_INVALID_SIGNATURE = -32005;
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
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    async forwardToolCall(call, 
    /**
     * The actual function that executes the MCP tool and returns raw output.
     * Proxy A calls this only after Proxy B has accepted.
     */
    executeTool) {
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
        let acceptance;
        try {
            const resp = await fetch(`${this.cfg.proxyBEndpoint}/accept`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ intent: intentEnv, estimated_cost_usd: p._estimated_cost_usd }),
            });
            const body = await resp.json();
            if (!resp.ok || !body.acceptance) {
                return this._mcpError(call.id, ERR_UNAUTHORIZED, body.error ?? "Proxy B rejected intent");
            }
            acceptance = body.acceptance;
        }
        catch (err) {
            return this._mcpError(call.id, ERR_UNAUTHORIZED, `Proxy B unreachable: ${err}`);
        }
        // 3. Execute the actual tool
        let outputData;
        let status = "COMPLETED";
        try {
            outputData = await executeTool(call);
        }
        catch (err) {
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
        }).catch(() => { }); // best-effort
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
    _mcpError(id, code, message) {
        return { jsonrpc: "2.0", id, error: { code, message } };
    }
}
/**
 * ProxyB validates an incoming IntentEnvelope and — if all checks pass —
 * returns a signed AcceptanceReceipt.
 */
export class ProxyBGateway {
    cfg;
    intentEntryHashes = new Map(); // trace_id → entry_hash
    constructor(cfg) {
        this.cfg = cfg;
    }
    async handleIntent(intent, estimatedCostUsd = 0) {
        // 1. TTL check
        if (!this.cfg.nonceRegistry.checkExpiry(intent.expires_at)) {
            return { error: "Intent envelope has expired", errorCode: ERR_EXPIRED };
        }
        // 2. Anti-replay nonce check
        const consumed = this.cfg.nonceRegistry.consume(intent.initiator.did, intent.payload.nonce, intent.expires_at);
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
            await verifySignature(intent, proxySig, pubKey);
        }
        catch (e) {
            return { error: `Signature verification failed: ${e}`, errorCode: ERR_INVALID_SIGNATURE };
        }
        // 4. Risk budget check (D4)
        const budgetResult = this.cfg.budgetEngine.check(intent.initiator.did, intent.target.tool_name, estimatedCostUsd);
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
        return { acceptance };
    }
    async handleExecution(execution) {
        const intentHash = this.intentEntryHashes.get(execution.trace_id);
        this.cfg.ledger.append("EXECUTION_RECORD", execution, intentHash ? [intentHash] : []);
        // Record spend after successful execution
        // (In production: extract cost from the execution envelope metadata)
        // this.cfg.budgetEngine.recordSpend(initiatorDid, actualCostUsd);
    }
}
//# sourceMappingURL=trust-proxy.js.map