🛡️ TrustAgentAI

The Execution Accountability Layer for Autonomous AI Systems

TrustAgentAI provides cryptographic non-repudiation and tamper-evident execution records for high-value AI actions.

We bridge the gap between AI Connectivity (MCP) and Enterprise Liability. If your agents move money, modify infrastructure, or access regulated data, TrustAgentAI ensures those actions are mathematically and legally provable.

🛑 The Problem: The Liability Gap

AI agents are transitioning from chatbots to autonomous executors (treasury management, automated procurement, devops). However, current tools only provide observability. They cannot:

Prevent Repudiation: Stop an agent owner from claiming "I didn't authorize this $50k wire transfer."

Bind Intent to Execution: Prove that the resulting action matches the agent's original intent without tampering.

Ensure Forensics: Provide a "Black Box" that satisfies auditors (SOC2, SOX) and insurance providers.

🚀 The Solution: A2A Accountability Protocol (v0.4)

TrustAgentAI implements a 3-phase (plus optional Ack) cryptographic handshake that decouples agent logic from commitment recording.

1. Intent Handshake

The agent generates an Intent Envelope. The Trust Proxy intercepts it, verifies authority via Verifiable Credentials (VC), and signs it.

Anti-Replay: Strict expires_at TTL and nonce uniqueness.

MCP Binding: Hard-linked to mcp_deployment_id and tool_schema_hash.

2. Policy Enforcement

The receiving party (Agent B or Tool) evaluates the intent and issues an Acceptance Receipt, cryptographically freezing the policy state (policy_eval_hash).

3. Execution & DAG Ledger

Once finished, an Execution Envelope binds the result to the intent hash. All artifacts are recorded in a Streaming DAG Ledger (Directed Acyclic Graph), ensuring a tamper-evident audit trail even if the network fails.

🛠️ Technical Moats (v0.4 Specs)

Hash Target Rule: We follow a strict JCS (RFC 8785) canonicalization. Hashes are computed on the payload excluding signatures, allowing for clean countersigning (Agent TEE + Proxy).

Dual-Signature Support: High-value actions require a signature from both the Agent's secure enclave and the organizational Proxy.

Streaming DAG: Every handshake phase is a node in a graph, linked by prev_entry_hashes[], preventing "deleted history" attacks.

Dispute Packs: One-click export of Merkle Paths and L2 Anchor receipts for legal arbitration.

⚡ Quick Start

1. Run the Trust Proxy (Rust-based Sidecar)

Wrap your existing MCP server (e.g., a Stripe or SQLite server):

# Install CLI
curl -sL [https://trustagent.ai/install.sh](https://trustagent.ai/install.sh) | bash

# Wrap your MCP server
trustagent start --target "npx @modelcontextprotocol/server-sqlite --db prod.db" \
                 --port 8080 \
                 --enforce-dual-sig


2. Audit an Execution Record

View a cryptographically sealed record from your local DAG ledger:

{
  "envelope_type": "IntentEnvelope",
  "spec_version": "0.4",
  "trace_id": "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "args_hash": "a5b9...9f1",
    "nonce": "8f42d9a1"
  },
  "signatures": [
    {
      "role": "proxy",
      "kid": "did:workload:proxy-A#key-1",
      "signed_digest": "c4d3...e21",
      "value": "eyJhbGciOiJFZERTQSJ9..."
    }
  ]
}


🏢 Enterprise Features

L2 Merkle Anchoring: Batch thousands of receipts and anchor them to Base (Coinbase L2) for immutable finality.

Dispute Console: A dashboard for CISO and Legal teams to replay incidents and verify Merkle proofs.

Zero-Trust Identity: Native integration with SPIFFE/OIDC workload identities.

Explore Enterprise ➡️

🤝 Contributing

Liability infrastructure must be open. We are looking for contributors interested in Rust (Tokio/Axum), Cryptography (Ed25519/JCS), and AI Agent Frameworks.

Please check CONTRIBUTING.md and our Architecture Specs.

📄 License

Licensed under the Apache License, Version 2.0. See LICENSE for more information.
