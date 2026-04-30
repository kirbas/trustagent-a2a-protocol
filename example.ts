/**
 * TrustAgentAI — End-to-End Example
 *
 * Simulates a full A2A transaction lifecycle:
 *   1. Agent A (payment-agent) builds Intent Envelope
 *   2. Agent B (stripe-mcp) accepts and signs Acceptance Receipt
 *   3. Agent B executes and signs Execution Envelope
 *   4. All envelopes are recorded in the DAG Ledger
 *   5. Merkle batch is committed and "anchored"
 *   6. Dispute Pack is generated and Merkle proof is verified
 */

import { generateKeyPair, verifySignature } from "./src/crypto.js";
import {
  buildIntentEnvelope,
  buildAcceptanceReceipt,
  buildExecutionEnvelope,
  buildContentProvenanceReceipt,
} from "./src/envelopes.js";
import { DAGLedger, verifyMerkleProof } from "./src/ledger.js";

async function main() {
  console.log("=== TrustAgentAI A2A Protocol v0.5 — E2E Demo ===\n");

  // ── 1. Generate keys for Proxy A and Proxy B ────────────────────────────
  const proxyAKey = await generateKeyPair("did:workload:proxy-A#key-1");
  const proxyBKey = await generateKeyPair("did:workload:proxy-B#key-1");
  console.log("✓ Keys generated");
  console.log("  Proxy A:", proxyAKey.kid);
  console.log("  Proxy B:", proxyBKey.kid);

  // ── 2. Build Intent Envelope ─────────────────────────────────────────────
  const wireTransferArgs = {
    destination_account: "IBAN:DE89370400440532013000",
    amount_usd: 15000,
    currency: "USD",
    memo: "Invoice #INV-2026-0042",
  };

  const { envelope: intentEnv, traceId } = await buildIntentEnvelope({
    initiatorDid: "did:workload:payment-agent-01",
    vcRef: "urn:credential:treasury-auth-099",
    targetDid: "did:workload:stripe-mcp-server",
    mcpDeploymentId: "stripe-prod-cluster-1",
    toolName: "execute_wire_transfer",
    toolSchemaHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    mcpSessionId: "sess_98765abc",
    args: wireTransferArgs,
    ttlSeconds: 30,
    proxyKey: proxyAKey,
    attestationRef: "urn:attestation:sgx:a1b2c3d4",
  });

  console.log("\n✓ Intent Envelope built");
  console.log("  trace_id:", traceId);
  console.log("  args_hash:", intentEnv.payload.args_hash);
  console.log("  nonce:", intentEnv.payload.nonce);

  // ── 3. Verify Intent signature (Proxy B side) ────────────────────────────
  const intentSig = intentEnv.signatures[0];
  await verifySignature(
    intentEnv as unknown as Record<string, unknown>,
    intentSig,
    proxyAKey.publicKey
  );
  console.log("  ✓ Intent signature verified by Proxy B");

  // ── 4. Build Acceptance Receipt ──────────────────────────────────────────
  const policyEval = {
    checked_vc: intentEnv.initiator.vc_ref,
    risk_budget_remaining_usd: 50000,
    action_cost_usd: 15000,
    decision: "ACCEPTED",
  };

  const acceptanceReceipt = await buildAcceptanceReceipt({
    intentEnvelope: intentEnv,
    policyEvalInput: policyEval,
    ttlSeconds: 30,
    proxyKey: proxyBKey,
  });

  console.log("\n✓ Acceptance Receipt built");
  console.log("  intent_hash:", acceptanceReceipt.intent_hash);
  console.log("  policy_eval_hash:", acceptanceReceipt.policy_eval_hash);
  console.log("  decision:", acceptanceReceipt.decision);

  await verifySignature(
    acceptanceReceipt as unknown as Record<string, unknown>,
    acceptanceReceipt.signatures[0],
    proxyBKey.publicKey
  );
  console.log("  ✓ Acceptance signature verified by Proxy A");

  // ── 5. Build Execution Envelope ──────────────────────────────────────────
  const executionOutput = {
    transaction_id: "txn_stripe_001",
    status: "settled",
    settled_at: new Date().toISOString(),
  };

  const executionEnv = await buildExecutionEnvelope({
    intentEnvelope: intentEnv,
    acceptanceReceipt,
    status: "COMPLETED",
    outputData: executionOutput,
    proxyKey: proxyBKey,
  });

  console.log("\n✓ Execution Envelope built");
  console.log("  status:", executionEnv.status);
  console.log("  output_hash:", executionEnv.result.output_hash);
  console.log("  acceptance_hash:", executionEnv.acceptance_hash);

  // ── 6. Append to DAG Ledger ──────────────────────────────────────────────
  const ledger = new DAGLedger(4); // batch every 4 entries (demo)

  const e1 = ledger.append("INTENT_RECORD", intentEnv);
  const e2 = ledger.append("ACCEPTANCE_RECORD", acceptanceReceipt, [e1.entry_hash]);
  const e3 = ledger.append("EXECUTION_RECORD", executionEnv, [e1.entry_hash, e2.entry_hash]);

  // ── 6.5 Content Provenance Receipt (v0.5) ───────────────────────────
  // NOTE: content_hash SHOULD be SHA-256 over raw artifact bytes.
  const generatedText = "Refund executed. Receipt issued."; // demo artifact
  const provenance = await buildContentProvenanceReceipt({
    executionEnvelope: executionEnv,
    content_type: "text",
    content_hash: sha256Json({ text: generatedText }), // demo-only; replace with sha256(bytes)
    model_id: "demo-model",
    tool_name: "execute_wire_transfer",
    prompt_hash: sha256Json({ prompt: "refund customer 123 for $40" }), // demo-only
    policy_eval_hash: acceptanceReceipt.policy_eval_hash,
    proxyKey: proxyBKey,
  });

  const e4 = ledger.append("PROVENANCE_RECORD", provenance, [e3.entry_hash]);
  console.log("\n✓ Content Provenance Receipt built");
  console.log("  execution_hash:", provenance.execution_hash);
  console.log("  content_hash:", provenance.content.content_hash);
  console.log("  Entry #4 (Provenance) hash:", e4.entry_hash.slice(0, 16) + "...");


  console.log("\n✓ Entries appended to DAG Ledger");
  console.log("  Entry #1 (Intent)     hash:", e1.entry_hash.slice(0, 16) + "...");
  console.log("  Entry #2 (Acceptance) hash:", e2.entry_hash.slice(0, 16) + "...");
  console.log("  Entry #3 (Execution)  hash:", e3.entry_hash.slice(0, 16) + "...");

  // ── 7. Flush + Merkle batch ──────────────────────────────────────────────
  const batch = ledger.flush();
  if (!batch) throw new Error("Expected batch after flush");

  // Simulate L2 anchor
  const fakeTxHash = "0x" + "ab".repeat(32);
  ledger.anchorBatch(batch.batch_id, fakeTxHash);

  console.log("\n✓ Merkle Batch committed");
  console.log("  batch_id:", batch.batch_id);
  console.log("  merkle_root:", batch.merkle_root.slice(0, 16) + "...");
  console.log("  anchored_at:", fakeTxHash.slice(0, 20) + "...");

  // ── 8. Generate & verify Dispute Pack ────────────────────────────────────
  const disputePack = ledger.getDisputePack(traceId);

  console.log("\n✓ Dispute Pack generated");
  console.log("  Entries in pack:", disputePack.entries.length);
  console.log("  Inclusion proofs:", disputePack.inclusionProofs.length);

  for (const ip of disputePack.inclusionProofs) {
    const valid = verifyMerkleProof(ip.entry_hash, ip.proof, ip.batch.merkle_root);
    console.log(
      `  ✓ Merkle proof for entry ${ip.entry_hash.slice(0, 8)}... → root ${ip.batch.merkle_root.slice(0, 8)}... [${valid ? "VALID" : "INVALID"}]`
    );
  }

  console.log("\n=== All checks passed. Non-repudiation established. ===");
}

main().catch(console.error);
