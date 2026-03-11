TrustAgentAI Architecture

This document describes the internal design of the TrustAgentAI system, the operational logic of the Trust Proxy, and the mechanisms ensuring cryptographic execution accountability.

1. System Overview

TrustAgentAI operates as an Execution Accountability Layer. Its primary objective is to transform ephemeral API calls into legally significant and mathematically provable records.

Key Components:

Trust Proxy (Sidecar): A high-performance Rust-based proxy server that intercepts traffic between the agent and the tools (MCP).

Policy Engine: A validation module for intents based on Verifiable Credentials (VC) and OPA (Open Policy Agent).

Streaming DAG Ledger: A local log storage system organized as a Directed Acyclic Graph.

Merkle Coordinator: A module for aggregating ledger entries into Merkle Trees for subsequent blockchain anchoring.

2. Transaction Lifecycle (The Handshake)

The system implements a 4-phase handshake that guarantees non-repudiation at every stage.

sequenceDiagram
    participant A as Agent A (Initiator)
    participant PA as Trust Proxy A
    participant PB as Trust Proxy B
    participant B as Agent B / Tool

    A->>PA: call_tool(args)
    PA->>PA: Intent Binding & Signing
    PA->>PB: Intent Envelope (v0.4)
    PB->>PB: Policy & VC Check
    PB->>PA: Acceptance Receipt
    PB->>B: Execute Tool
    B->>PB: Return Result
    PB->>PB: Execution Signing
    PB->>PA: Execution Envelope
    PA->>PB: Receipt Ack (Optional)


3. Data Integrity and Hashing

To ensure deterministic proofs, TrustAgentAI adheres to strict data preparation rules:

3.1. Canonicalization (JCS)

Prior to computing any hash, all JSON objects undergo canonicalization following the RFC 8785 (JCS) standard. This prevents hash mismatches caused by whitespace or key ordering.

3.2. Hash Target Rule

The envelope hash (e.g., intent_hash) is computed from the object excluding the signatures field. This allows for the addition or updating of signatures (e.g., countersigning by the proxy) without changing the identifier of the intent itself.

4. Streaming DAG Ledger

Unlike classical blockchains with linear structures, TrustAgentAI utilizes a DAG (Directed Acyclic Graph) for its local registry.

Why DAG?

Asynchronicity: We can record Acceptance and Execution entries in parallel or with delay, linking them via prev_entry_hashes.

Branching: A single Intent can spawn multiple parallel sub-tasks that reference it as a parent.

Fault Tolerance: Even if tool execution fails due to a timeout, the Intent record is already permanently secured in the graph.

5. Merkle Anchoring & L2 Finality

To ensure local logs are "Dispute-grade" (suitable for arbitration), we utilize a two-tier trust system:

Local Level: Every entry_hash serves as a leaf in the current Merkle window.

Global Level: Every 60 seconds (or every 10,000 transactions), the proxy calculates the Merkle Root and transmits it to an L2 blockchain (Base/Ethereum) via an op_return transaction.

This proves the existence of a specific record at a specific point in time without publicly revealing the contents of all transactions.

6. Security and Anti-Replay

To prevent Replay Attacks in a distributed environment:

Strict TTL: Every envelope contains an expires_at field. The proxy rejects any packets if now > expires_at + skew_tolerance.

Nonce Uniqueness: Proxy B maintains a cache of used Nonces within the TTL window. A duplicate Nonce from the same DID results in an immediate block.

Dual-Signature: High-risk operations SHOULD require a signature from the agent's secure enclave (TEE) plus a signature from the organizational proxy.

7. MCP Integration

TrustAgentAI is designed as a transparent layer for the Model Context Protocol.

The proxy supports stdio and SSE transports.

The interceptor parses the JSON-RPC tools/call method.

In the event of a block, the proxy returns a standard MCP error response containing the cryptographic dispute_id.

8. Threat Model

Threat                Mitigation Mechanism

Agent Hallucination   Blocking via VC (Verifiable Credentials) limits and risk budgets.

Log Tampering         Immutability via hash chains, DAG structure, and Merkle Anchoring.

Key Compromise        Multi-signature support and VC Revocation mechanisms.

API Spoofing          Inclusion of tool_schema_hash and mcp_deployment_id in the Intent Envelope.
