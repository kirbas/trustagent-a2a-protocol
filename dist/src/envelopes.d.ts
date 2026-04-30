/**
 * TrustAgentAI — Envelope Builders
 * Constructs and signs Intent / Acceptance / Execution envelopes
 * per A2A Accountability Protocol v0.4
 */
import { KeyPair, SignatureBlock } from "./crypto.js";
export interface IntentEnvelopeParams {
    initiatorDid: string;
    vcRef: string;
    targetDid: string;
    mcpDeploymentId: string;
    toolName: string;
    toolSchemaHash: string;
    mcpSessionId: string;
    args: unknown;
    ttlSeconds?: number;
    proxyKey: KeyPair;
    agentKey?: KeyPair;
    attestationRef?: string;
}
export interface IntentEnvelope {
    envelope_type: "IntentEnvelope";
    spec_version: "0.4";
    trace_id: string;
    timestamp: string;
    expires_at: string;
    initiator: {
        did: string;
        vc_ref: string;
    };
    target: {
        did: string;
        mcp_deployment_id: string;
        tool_name: string;
        tool_schema_hash: string;
        mcp_session_id: string;
    };
    payload: {
        args_hash: string;
        nonce: string;
    };
    signatures: SignatureBlock[];
}
export declare function buildIntentEnvelope(p: IntentEnvelopeParams): Promise<{
    envelope: IntentEnvelope;
    traceId: string;
}>;
export interface AcceptanceReceiptParams {
    intentEnvelope: IntentEnvelope;
    policyEvalInput: unknown;
    ttlSeconds?: number;
    proxyKey: KeyPair;
}
export interface AcceptanceReceipt {
    envelope_type: "AcceptanceReceipt";
    spec_version: "0.4";
    trace_id: string;
    timestamp: string;
    expires_at: string;
    intent_hash: string;
    policy_eval_hash: string;
    decision: "ACCEPTED" | "REJECTED";
    signatures: SignatureBlock[];
}
export declare function buildAcceptanceReceipt(p: AcceptanceReceiptParams): Promise<AcceptanceReceipt>;
export interface ExecutionEnvelopeParams {
    intentEnvelope: IntentEnvelope;
    acceptanceReceipt: AcceptanceReceipt;
    status: "COMPLETED" | "FAILED";
    outputData: unknown;
    proxyKey: KeyPair;
}
export interface ExecutionEnvelope {
    envelope_type: "ExecutionEnvelope";
    spec_version: "0.4";
    trace_id: string;
    timestamp: string;
    intent_hash: string;
    acceptance_hash: string;
    status: "COMPLETED" | "FAILED";
    result: {
        output_hash: string;
    };
    signatures: SignatureBlock[];
}
export declare function buildExecutionEnvelope(p: ExecutionEnvelopeParams): Promise<ExecutionEnvelope>;
//# sourceMappingURL=envelopes.d.ts.map