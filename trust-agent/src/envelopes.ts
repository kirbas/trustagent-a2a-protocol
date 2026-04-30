/**
 * TrustAgentAI — Envelope Builders
 * Constructs and signs Intent / Acceptance / Execution envelopes
 * per A2A Accountability Protocol v0.4
 */

import { v4 as uuidv4 } from "uuid";
import { generateNonce, signEnvelope, sha256Json, computeEnvelopeHash } from "./crypto.js";
import type { KeyPair, SignatureBlock } from "./crypto.js";

// ─── Intent Envelope ─────────────────────────────────────────────────────────

export interface IntentEnvelopeParams {
  initiatorDid: string;
  vcRef: string;
  targetDid: string;
  mcpDeploymentId: string;
  toolName: string;
  toolSchemaHash: string;
  mcpSessionId: string;
  args: unknown;          // will be hashed, NOT stored
  ttlSeconds?: number;    // default 30s
  proxyKey: KeyPair;
  agentKey?: KeyPair;     // for Dual-Sign (high-value actions)
  attestationRef?: string;
}

export interface IntentEnvelope {
  envelope_type: "IntentEnvelope";
  spec_version: "0.5";
  trace_id: string;
  timestamp: string;
  expires_at: string;
  initiator: { did: string; vc_ref: string };
  target: {
    did: string;
    mcp_deployment_id: string;
    tool_name: string;
    tool_schema_hash: string;
    mcp_session_id: string;
  };
  payload: { args_hash: string; nonce: string };
  signatures: SignatureBlock[];
}

export async function buildIntentEnvelope(
  p: IntentEnvelopeParams
): Promise<{ envelope: IntentEnvelope; traceId: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (p.ttlSeconds ?? 30) * 1000);
  const traceId = `urn:uuid:${uuidv4()}`;

  const base: Omit<IntentEnvelope, "signatures"> = {
    envelope_type: "IntentEnvelope",
    spec_version: "0.5",
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

  const signatures: SignatureBlock[] = [];

  // Proxy signature (always required)
  const proxySig = await signEnvelope(
    base as Record<string, unknown>,
    p.proxyKey,
    "proxy",
    p.attestationRef
  );
  signatures.push(proxySig);

  // Agent countersignature (Dual-Sign for high-value)
  if (p.agentKey) {
    const dualBase = { ...base, signatures: [proxySig] };
    const agentSig = await signEnvelope(
      dualBase as Record<string, unknown>,
      p.agentKey,
      "agent"
    );
    signatures.push(agentSig);
  }

  const envelope: IntentEnvelope = { ...base, signatures };
  return { envelope, traceId };
}

// ─── Acceptance Receipt ───────────────────────────────────────────────────────

export interface AcceptanceReceiptParams {
  intentEnvelope: IntentEnvelope;
  policyEvalInput: unknown; // whatever policy was evaluated
  ttlSeconds?: number;
  proxyKey: KeyPair;
  decision?: "ACCEPTED" | "REJECTED";
}

export interface AcceptanceReceipt {
  envelope_type: "AcceptanceReceipt";
  spec_version: "0.5";
  trace_id: string;
  timestamp: string;
  expires_at: string;
  intent_hash: string;
  policy_eval_hash: string;
  decision: "ACCEPTED" | "REJECTED";
  signatures: SignatureBlock[];
}

export async function buildAcceptanceReceipt(
  p: AcceptanceReceiptParams
): Promise<AcceptanceReceipt> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (p.ttlSeconds ?? 30) * 1000);

  const base: Omit<AcceptanceReceipt, "signatures"> = {
    envelope_type: "AcceptanceReceipt",
    spec_version: "0.5",
    trace_id: p.intentEnvelope.trace_id,
    timestamp: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    intent_hash: computeEnvelopeHash(p.intentEnvelope as unknown as Record<string, unknown>),
    policy_eval_hash: sha256Json(p.policyEvalInput),
    decision: p.decision ?? "ACCEPTED",
  };

  const sig = await signEnvelope(base as Record<string, unknown>, p.proxyKey, "proxy");
  return { ...base, signatures: [sig] };
}

// ─── Execution Envelope ───────────────────────────────────────────────────────

export interface ExecutionEnvelopeParams {
  intentEnvelope: IntentEnvelope;
  acceptanceReceipt: AcceptanceReceipt;
  status: "COMPLETED" | "FAILED";
  outputData: unknown;   // will be hashed, NOT stored
  proxyKey: KeyPair;
}

export interface ExecutionEnvelope {
  envelope_type: "ExecutionEnvelope";
  spec_version: "0.5";
  trace_id: string;
  timestamp: string;
  intent_hash: string;
  acceptance_hash: string;
  status: "COMPLETED" | "FAILED";
  result: { output_hash: string };
  signatures: SignatureBlock[];
}

export async function buildExecutionEnvelope(
  p: ExecutionEnvelopeParams
): Promise<ExecutionEnvelope> {
  const base: Omit<ExecutionEnvelope, "signatures"> = {
    envelope_type: "ExecutionEnvelope",
    spec_version: "0.5",
    trace_id: p.intentEnvelope.trace_id,
    timestamp: new Date().toISOString(),
    intent_hash: computeEnvelopeHash(
      p.intentEnvelope as unknown as Record<string, unknown>
    ),
    acceptance_hash: computeEnvelopeHash(
      p.acceptanceReceipt as unknown as Record<string, unknown>
    ),
    status: p.status,
    result: { output_hash: sha256Json(p.outputData) },
  };

  const sig = await signEnvelope(base as Record<string, unknown>, p.proxyKey, "proxy");
  return { ...base, signatures: [sig] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content Provenance Receipt (v0.5)
// ─────────────────────────────────────────────────────────────────────────────
// Purpose: prove the existence/origin of a generated artifact WITHOUT storing it.
// Stores only hashes + minimal metadata, bound to an ExecutionEnvelope.

export interface ContentProvenanceReceiptParams {
  executionEnvelope: ExecutionEnvelope;

  content_type: "text" | "image" | "audio" | "video" | "code" | "other";
  content_hash: string;          // sha256 of raw artifact bytes (NOT JSON)
  content_size_bytes?: number;

  // Optional context
  model_id?: string;             // e.g. "gpt-5", "claude", "local-llm"
  tool_name?: string;            // MCP tool name
  prompt_hash?: string;          // sha256(prompt text)
  policy_eval_hash?: string;     // snapshot hash if available

  ttlSeconds?: number;           // default 30s
  proxyKey: KeyPair;             // signer key
}

export interface ContentProvenanceReceipt {
  envelope_type: "ContentProvenanceReceipt";
  spec_version: "0.5";
  trace_id: string;
  timestamp: string;
  expires_at: string;

  // Strong binding to execution
  execution_hash: string;
  intent_hash: string;
  acceptance_hash: string;
  output_hash: string;

  content: {
    content_type: "text" | "image" | "audio" | "video" | "code" | "other";
    content_hash: string;
    content_size_bytes?: number;
  };

  context?: {
    model_id?: string;
    tool_name?: string;
    prompt_hash?: string;
    policy_eval_hash?: string;
  };

  signatures: SignatureBlock[];
}

export async function buildContentProvenanceReceipt(
  p: ContentProvenanceReceiptParams
): Promise<ContentProvenanceReceipt> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (p.ttlSeconds ?? 30) * 1000);

  const execution_hash = computeEnvelopeHash(
    p.executionEnvelope as unknown as Record<string, unknown>
  );

  const base: Omit<ContentProvenanceReceipt, "signatures"> = {
    envelope_type: "ContentProvenanceReceipt",
    spec_version: "0.5",
    trace_id: p.executionEnvelope.trace_id,
    timestamp: now.toISOString(),
    expires_at: expiresAt.toISOString(),

    execution_hash,
    intent_hash: p.executionEnvelope.intent_hash,
    acceptance_hash: p.executionEnvelope.acceptance_hash,
    output_hash: p.executionEnvelope.result.output_hash,

    content: {
      content_type: p.content_type,
      content_hash: p.content_hash,
      ...(p.content_size_bytes != null ? { content_size_bytes: p.content_size_bytes } : {}),
    },

    ...(p.model_id || p.tool_name || p.prompt_hash || p.policy_eval_hash
      ? {
          context: {
            ...(p.model_id ? { model_id: p.model_id } : {}),
            ...(p.tool_name ? { tool_name: p.tool_name } : {}),
            ...(p.prompt_hash ? { prompt_hash: p.prompt_hash } : {}),
            ...(p.policy_eval_hash ? { policy_eval_hash: p.policy_eval_hash } : {}),
          },
        }
      : {}),
  };

  const sig = await signEnvelope(base as Record<string, unknown>, p.proxyKey, "proxy");
  return { ...base, signatures: [sig] };
}

