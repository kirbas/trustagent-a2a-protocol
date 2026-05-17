# Agent Workflow — Autonomous Handshake Protocol

This document outlines the lifecycle of a transaction as handled by the real autonomous agents in this repository.

---

## 1. The Autonomous Reasoning Loop

Each agent (Bank-A and Bank-B) operates an internal reasoning loop. Unlike static scripts, these agents evaluate the state of the protocol before taking action.

### Perception Phase
The agent subscribes to the **Hybrid SSE Stream** from its local proxy. It "sees":
- Peer intents arriving.
- Budget status updates.
- Cryptographic verification results.

### Analysis (Internal Thoughts)
The agent emits "thoughts" via `POST /thought` to explain its logic:
> *"I see a request for a $5,000 security report. Verifying peer signature against my local registry..."*

### Action Phase
The agent triggers the protocol via the proxy:
- **Bank-A**: Issues a `POST /invoke` to start a new handshake.
- **Bank-B**: Evaluates the `AcceptanceReceipt` logic and signs if policy-compliant.

---

## 2. The 3-Phase Handshake (v0.5)

### Phase 1: Intent Binding
- **Trigger**: Bank-A agent decides to call a tool.
- **Action**: Bank-A Proxy builds a signed `IntentEnvelope`.
- **Logic**: Includes `trace_id`, `initiator_did`, and JCS-canonicalized tool parameters.

### Phase 2: Acceptance & Policy
- **Trigger**: Bank-B Proxy receives the Intent.
- **Verification**: Bank-B Proxy checks TTL, Nonces, and Ed25519 signatures.
- **Budget**: `RiskBudgetEngine` checks if the cost fits within the allowed daily limit.
- **Action**: Returns a signed `AcceptanceReceipt` (ACCEPTED or REJECTED).

### Phase 3: Execution & Dual-Signing
- **Action**: Bank-A Proxy executes the tool.
- **Commitment**: Bank-A sends the `ExecutionEnvelope` to Bank-B.
- **Finality**: Bank-B **dual-signs** the result, ensuring D1 Non-repudiation.

---

## 3. Post-Execution Lifecycle

### Merkle Anchoring (D5)
After each transaction, Bank-B's `merkle-anchor` service:
1. Batches the latest signed signatures.
2. Computes a SHA-256 Merkle Root.
3. Broadcasts the root to **Base Sepolia**.
4. Stores per-leaf inclusion proofs for the **Dispute Console**.

### Content Provenance
Bank-A Proxy generates a `ContentProvenanceReceipt` (CPR). This binds the actual tool output (e.g., a file or data blob) to the `trace_id` and the on-chain anchor, ensuring the data itself is tamper-evident.