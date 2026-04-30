/**
 * TrustAgentAI — Envelope Builders
 * Constructs and signs Intent / Acceptance / Execution envelopes
 * per A2A Accountability Protocol v0.4
 */
import { v4 as uuidv4 } from "uuid";
import { generateNonce, signEnvelope, sha256Json, computeEnvelopeHash, } from "./crypto.js";
export async function buildIntentEnvelope(p) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (p.ttlSeconds ?? 30) * 1000);
    const traceId = `urn:uuid:${uuidv4()}`;
    const base = {
        envelope_type: "IntentEnvelope",
        spec_version: "0.4",
        trace_id: traceId,
        timestamp: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        initiator: { did: p.initiatorDid, vc_ref: p.vcRef },
        target: {
            did: p.targetDid,
            mcp_deployment_id: p.mcpDeploymentId,
            tool_name: p.toolName,
            tool_schema_hash: p.toolSchemaHash,
            mcp_session_id: p.mcpSessionId,
        },
        payload: {
            args_hash: sha256Json(p.args),
            nonce: generateNonce(),
        },
    };
    const signatures = [];
    // Proxy signature (always required)
    const proxySig = await signEnvelope(base, p.proxyKey, "proxy", p.attestationRef);
    signatures.push(proxySig);
    // Agent countersignature (Dual-Sign for high-value)
    if (p.agentKey) {
        const dualBase = { ...base, signatures: [proxySig] };
        const agentSig = await signEnvelope(dualBase, p.agentKey, "agent");
        signatures.push(agentSig);
    }
    const envelope = { ...base, signatures };
    return { envelope, traceId };
}
export async function buildAcceptanceReceipt(p) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (p.ttlSeconds ?? 30) * 1000);
    const base = {
        envelope_type: "AcceptanceReceipt",
        spec_version: "0.4",
        trace_id: p.intentEnvelope.trace_id,
        timestamp: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        intent_hash: computeEnvelopeHash(p.intentEnvelope),
        policy_eval_hash: sha256Json(p.policyEvalInput),
        decision: "ACCEPTED",
    };
    const sig = await signEnvelope(base, p.proxyKey, "proxy");
    return { ...base, signatures: [sig] };
}
export async function buildExecutionEnvelope(p) {
    const base = {
        envelope_type: "ExecutionEnvelope",
        spec_version: "0.4",
        trace_id: p.intentEnvelope.trace_id,
        timestamp: new Date().toISOString(),
        intent_hash: computeEnvelopeHash(p.intentEnvelope),
        acceptance_hash: computeEnvelopeHash(p.acceptanceReceipt),
        status: p.status,
        result: { output_hash: sha256Json(p.outputData) },
    };
    const sig = await signEnvelope(base, p.proxyKey, "proxy");
    return { ...base, signatures: [sig] };
}
//# sourceMappingURL=envelopes.js.map