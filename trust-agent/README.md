# TrustAgentAI · A2A Accountability Protocol

[![npm version](https://img.shields.io/npm/v/@trustagentai/a2a-core)](https://www.npmjs.com/package/@trustagentai/a2a-core)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)

**Your MCP agent just called `execute_wire_transfer`.**  
**Can you prove it happened? Can you prove who authorized it? Can you prove the result wasn't tampered with?**

TrustAgentAI is the accountability layer for the Agentic Economy. We provide the "Digital Notary" infrastructure required for autonomous systems to handle real budgets with mathematical certainty.

---

## 🚀 The Accountability Gap

MCP connects agents to tools, but it doesn't make those connections **accountable**. TrustAgentAI adds a cryptographic receipt system to every high-stakes action:

- **Intent Envelope** (v0.5): Signed proof of initiator's intent.
- **Acceptance Receipt**: Signed proof of tool validation and budget check.
- **Execution Envelope**: Signed proof of outcome hash, dual-signed for non-repudiation.
- **Content Provenance Receipt** (v0.5): Cryptographic binding of tool outputs to the transaction trace.

---

## 🛠 Features

- **Ed25519 Signatures**: Tamper-evident, verifiable, and non-repudiable.
- **JCS Canonicalization (RFC 8785)**: Deterministic hashing across all platforms.
- **DAG Ledger**: Causal ordering of events with persistent forensic storage.
- **Merkle Anchoring**: Immutable batching anchored to **Base Sepolia**.
- **Risk Budget Engine**: Fail-closed enforcement of agent spending limits.

---

## 📦 Quick Start

```bash
npm install @trustagentai/a2a-core
```

### Protocol Lifecycle

```typescript
import { ProxyAGateway, ProxyBGateway } from "@trustagentai/a2a-core";

// Sidecar architecture wraps MCP tool calls automatically.
// Refer to the /docs directory for full implementation guides.
```

---

## 🏗 Repository Structure

- **`src/`**: Reference implementation of the A2A Accountability Protocol.
- **`dist/`**: Pre-built distribution for high-performance sidecar deployment.
- **`docs/`**: Protocol specification (v0.5) and architectural deep-dives.

---

## 🌐 Project Context

This library is a core component of the **TrustAgentAI Procurement Handshake Demo**. It powers the distributed ledger and cryptographic verification used by the autonomous bank nodes in this repository.

See the root **[docs/README.md](../docs/README.md)** for instructions on running the full multi-node demo.
