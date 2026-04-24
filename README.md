# TrustAgentAI · A2A Accountability Protocol

[![npm version](https://img.shields.io/npm/v/@trustagentai/a2a-core)](https://www.npmjs.com/package/@trustagentai/a2a-core)
[![npm downloads](https://img.shields.io/npm/dm/@trustagentai/a2a-core)](https://www.npmjs.com/package/@trustagentai/a2a-core)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)
[![GitHub tag](https://img.shields.io/github/v/tag/kirbas/trustagent-a2a-protocol)](https://github.com/kirbas/trustagent-a2a-protocol/releases)

**Your MCP agent just called `execute_wire_transfer`.**  
**Can you prove it happened? Can you prove who authorized it? Can you prove the result wasn't tampered with?**

Without TrustAgentAI — no.

---

## The problem MCP doesn't solve

MCP connects AI agents to tools. It does not make those connections **accountable**.

When Agent A calls a tool on Agent B today:

| What you get | What you don't get |
|---|---|
| A log entry (editable by admins) | Cryptographic proof of authorization |
| A timestamp (from a clock you control) | Proof that intent matched outcome |
| An API response | Evidence admissible in a dispute |
| Observability | Non-repudiation |

This gap doesn't matter for chatbots.  
It matters enormously when agents **move money, modify infrastructure, or act on behalf of legal entities**.

The MCP ecosystem is moving fast toward exactly those use cases. TrustAgentAI is the accountability layer it's missing.

---

## What TrustAgentAI does

We add a **cryptographic receipt system** to MCP tool calls — without changing your existing agents or tools.

Every high-stakes action produces three signed artifacts:

```
Intent Envelope      → Agent A signs: "I intend to call X with these args"
Acceptance Receipt   → Agent B signs: "I received and validated this intent"
Execution Envelope   → Agent B signs: "I executed it, here is the outcome hash"
```

These artifacts are:
- Signed with **Ed25519** — tamper-evident, verifiable without a server
- Hashed with **JCS (RFC 8785)** — canonical, deterministic, cross-platform
- Chained in a **DAG ledger** — causal order is cryptographically enforced
- Batched into **Merkle trees** anchored on L2 — immutable after the fact

The result: a **Dispute Pack** — a self-contained bundle of cryptographic evidence that proves what happened, when, and who authorized it. Designed to satisfy auditors, insurers, and legal arbitrators.

---

## Quick Start

```bash
npm install @trustagentai/a2a-core
```

### Protect an MCP tool call in 3 steps

```typescript
import { generateKeyPair } from "@trustagentai/a2a-core/crypto";
import { buildIntentEnvelope, buildExecutionEnvelope } from "@trustagentai/a2a-core/envelopes";
import { DAGLedger } from "@trustagentai/a2a-core/ledger";

// 1. Generate keys for your proxy (done once at setup)
const proxyKey = await generateKeyPair("did:workload:my-agent#key-1");
const ledger = new DAGLedger();

// 2. Before the tool call — build and sign Intent
const { envelope: intent } = await buildIntentEnvelope({
  initiatorDid: "did:workload:payment-agent-01",
  vcRef: "urn:credential:treasury-auth-099",
  targetDid: "did:workload:stripe-mcp-server",
  mcpDeploymentId: "stripe-prod-cluster-1",
  toolName: "execute_wire_transfer",
  toolSchemaHash: "e3b0c44298fc1c149afbf4c8996fb924",
  mcpSessionId: "sess_abc123",
  args: { amount_usd: 5000, destination: "IBAN:DE89..." },
  proxyKey,
});

// 3. After execution — sign the outcome and record everything
const execution = await buildExecutionEnvelope({
  intentEnvelope: intent,
  acceptanceReceipt: acceptance, // from Proxy B
  status: "COMPLETED",
  outputData: { transaction_id: "txn_001", status: "settled" },
  proxyKey,
});

ledger.append("INTENT_RECORD", intent);
ledger.append("EXECUTION_RECORD", execution);

// Generate a Dispute Pack for this transaction
const proof = ledger.getDisputePack(intent.trace_id);
// proof.inclusionProofs → Merkle path to anchored root
// proof.entries        → signed artifacts (Intent + Acceptance + Execution)
```

### Run the full example locally

```bash
git clone https://github.com/kirbas/trustagent-a2a-protocol
cd trustagent-a2a-protocol
npm install
npm run example       # full A2A lifecycle with Merkle proof verification
npm run proxy:test    # Proxy A ↔ Proxy B: success, budget exceeded, replay attack, forbidden tool
```

---

## How it fits into your MCP stack

```
┌─────────────────────────────────────────────────────┐
│                  Your MCP Orchestrator               │
└──────────────────────┬──────────────────────────────┘
                       │  tool_call (JSON-RPC)
              ┌────────▼────────┐
              │   Trust Proxy A  │  ← builds + signs IntentEnvelope
              │   (your side)    │
              └────────┬────────┘
                       │  IntentEnvelope (signed)
              ┌────────▼────────┐
              │   Trust Proxy B  │  ← verifies TTL, nonce, Ed25519 signature
              │   (tool side)    │  ← checks risk budget (D4)
              └────────┬────────┘  ← signs AcceptanceReceipt
                       │
              ┌────────▼────────┐
              │   Your MCP Tool  │  execute_wire_transfer / deploy / delete / etc.
              └────────┬────────┘
                       │  result
              ┌────────▼────────┐
              │   DAG Ledger     │  ← tamper-evident, Merkle-batched
              │ + Timestamp Reg  │  ← anchored to L2 blockchain
              └─────────────────┘
                       │
              ┌────────▼────────┐
              │   Dispute Pack   │  ← cryptographic evidence bundle
              └─────────────────┘
```

The proxies are **sidecars** — they intercept existing MCP JSON-RPC traffic.  
No changes to your agents or tools required.

---

## Security properties

| Property | How it's achieved |
|---|---|
| **Non-repudiation (D1)** | Bilateral Ed25519 signatures on every phase |
| **Intent binding** | `args_hash` + `tool_schema_hash` locked in the signed envelope |
| **Anti-replay** | Per-`(did, nonce)` uniqueness with TTL and clock skew tolerance |
| **Tamper-evident history (D5)** | Merkle-batched DAG entries anchored to L2 blockchain |
| **Agent drift prevention (D4)** | Risk budget enforced at proxy level before execution |
| **Dual-signature support** | Agent + Proxy countersign for high-value actions (TEE-ready) |
| **Privacy** | Only `args_hash` and `output_hash` on-chain — raw args stay off-chain |
| **Dispute-grade proof (D2)** | Dispute Pack: Merkle path + signed artifacts + L2 anchor ref |

---

## What's in this repo

```
src/
  crypto.ts           Ed25519 signing · JCS hashing · key generation
  envelopes.ts        Intent, Acceptance, Execution envelope builders
  ledger.ts           DAG ledger · Merkle tree · Timestamp Registry · Dispute Pack
  nonce-registry.ts   Anti-replay store with TTL
  risk-budget.ts      Per-agent policy enforcement (D4)
  trust-proxy.ts      ProxyAGateway + ProxyBGateway (MCP middleware)
  proxy-server.ts     HTTP server: /accept · /executed · /dispute/:id

example.ts            End-to-end lifecycle: keygen → Intent → Acceptance → Execution → Merkle proof
proxy-test.ts         Integration test: 4 security scenarios

docs/
  spec-v0.4.md        Full protocol specification
  architecture.md     Component diagram and design decisions
  dispute-pack.md     Dispute Pack format and verification guide
```

---

## Protocol specification

The full A2A Accountability Protocol v0.4 is published at:  
**[trustagentai.net/trustagentai-a2a-protocol](https://trustagentai.net/trustagentai-a2a-protocol)**
- Protocol spec v0.4: [trustagentai.net/trustagentai-a2a-protocol](https://trustagentai.net/trustagentai-a2a-protocol)
- Protocol spec v0.5: [trustagentai.net/trustagentai-a2a-protocol-v05](https://trustagentai.net/trustagentai-a2a-protocol-v05) ← Content Provenance Layer

Key sections:
- §3 Transaction Lifecycle — the 3-phase cryptographic handshake
- §4 Data Formats — Hash Target Rule (JCS + SHA-256), envelope schemas
- §5 Validation Rules — TTL, anti-replay, dual-signature policy
- §6 Streaming Ledger — DAG architecture, Merkle leaf definition
- §8 Dispute Resolution — Dispute Pack format, inclusion proof, L2 anchor

---

## Roadmap

### Now · v0.4 RFC phase
- [x] Protocol specification v0.4
- [x] TypeScript reference implementation
- [x] Ed25519 signing + JCS canonicalization
- [x] DAG ledger + Merkle batching + Timestamp Registry
- [x] Trust Proxy A + B (MCP middleware)
- [x] Risk budget engine (D4)
- [x] Dispute Pack generation + Merkle inclusion proof
- [x] HTTP server with `/accept`, `/executed`, `/dispute/:id`

### Next · v0.5
- [ ] Publish `@trustagentai/a2a-core` to npm
- [ ] Python SDK
- [ ] L2 anchoring integration (Base / Arbitrum)
- [ ] Verifiable Credential (VC) policy loader
- [ ] Native MCP SDK integration
- [ ] `good first issue` tasks — see [Issues](https://github.com/kirbas/trustagent-a2a-protocol/issues)

### Later
- [ ] Rust implementation (performance-critical proxy path)
- [ ] Hosted Timestamp Registry (cloud, SLA-backed)
- [ ] Dispute Console UI (compliance dashboard)
- [ ] TEE attestation (SGX / TDX) for agent identity

---

## Contributing

Accountability infrastructure must be open. We welcome:

- **Protocol feedback** — open a [Discussion](https://github.com/kirbas/trustagent-a2a-protocol/discussions) or comment on open RFCs
- **SDK ports** — Python, Go, Rust implementations
- **MCP integrations** — connect TrustAgentAI to existing MCP servers and tools
- **Security review** — cryptography, replay attack vectors, edge cases in the spec

Getting started:

1. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md)
2. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) for design context
3. Pick a [`good first issue`](https://github.com/kirbas/trustagent-a2a-protocol/issues?q=label%3A%22good+first+issue%22)

All contributors must sign the [CLA](./CLA.md).  
This protects both contributors and the project's ability to sustain open-core development long-term.

---

## Why open source?

Trust infrastructure only works if it's auditable.  
A closed "trust layer" is a contradiction in terms.

The core protocol, SDK, and reference proxy are open under Apache 2.0 — permanently.  
We plan to build sustainable funding through hosted infrastructure and enterprise tooling on top of this foundation.

---

## License

[Apache License 2.0](./LICENSE)

Apache 2.0 includes an explicit patent grant — important for cryptographic protocols used in regulated industries.

---

## Links

- Website: [trustagentai.net](https://trustagentai.net)
- Protocol spec: [trustagentai.net/trustagentai-a2a-protocol](https://trustagentai.net/trustagentai-a2a-protocol)
- - Protocol spec v0.4: [trustagentai.net/trustagentai-a2a-protocol](https://trustagentai.net/trustagentai-a2a-protocol)
- Protocol spec v0.5: [trustagentai.net/trustagentai-a2a-protocol-v05](https://trustagentai.net/trustagentai-a2a-protocol-v05) ← Content Provenance Layer
- LinkedIn: [linkedin.com/company/trustagentai](https://www.linkedin.com/company/trustagentai/)
- Discussions: [GitHub Discussions](https://github.com/kirbas/trustagent-a2a-protocol/discussions)
