# Agent Context — TrustAgentAI Production Infrastructure

This document is the **single source of truth** for any developer or AI agent working on this repository. It reflects the transition from mock-based simulation to real autonomous agent integration.

---

## Core Philosophy: Accountability as a Sidecar

This repository implements an **Execution Accountability Layer**. It wraps standard MCP (Model Context Protocol) tool calls in a 3-phase cryptographic handshake (Intent → Acceptance → Execution) to ensure non-repudiation and forensic auditability.

---

## Technical Stack & Invariants

### 1. Database: SQLite with WAL
- **Mode**: All services use `PRAGMA journal_mode = WAL;`.
- **Concurrent Access**: High-frequency agent writes are decoupled from UI reads.
- **Timeout**: `busy_timeout = 5000` is enforced to prevent locking during heavy anchoring.

### 2. Transport: Hybrid SSE/DB
- **SSE (Live)**: Real-time "Thought Streams" and handshake events are broadcast via Server-Sent Events.
- **SQLite (Audit)**: All signed envelopes are persisted for forensic reconstruction.
- **Matching**: Use `trace_id` (URN UUID) to correlate events across services.

### 3. Protocol: v0.5 Specification
- **Canonicalization**: **RFC 8785 (JCS)** is mandatory for all hashing. Use `sha256Json` from `@trustagentai/a2a-core`.
- **Signatures**: Ed25519 keys are generated at startup. Bank-A registers its public key with Bank-B via an automated retry loop.
- **Dual-Signing**: Bank-B **must** dual-sign the `ExecutionEnvelope` before it is considered binding (D1 Invariant).

---

## Repository Layout (Production)

```
Trust-Agent/
├── trust-agent/           @trustagentai/a2a-core (CORE LIBRARY — READ ONLY)
├── Bank-A/                (Purchaser Node)
│   ├── proxy/             TypeScript Gateway (SSE + SQLite WAL)
│   └── agent/             Real Autonomous Agent (Strands/AO Runtime)
├── Bank-B/                (Vendor Node)
│   ├── proxy/             TypeScript Gateway (Ledger + Budget Engine)
│   ├── agent/             Reactive Verification Agent
│   └── merkle-anchor/     Python L2 Notary (Merkle Batching → Base Sepolia)
├── frontend/              React Visualizer (Defensive Parsing + Live SSE)
├── docker-compose.yml     Orchestrates 6+ containers
└── docs/                  Documentation (README, ARCHITECTURE, CONTEXT)
```

---

## Agent Lifecycle & Reasoning

### Autonomous Reasoning Loops
The real agents in `Bank-A/agent/` and `Bank-B/agent/` do not just emit strings; they follow a reasoning-forward loop:
1. **Perception**: Monitor SSE streams for peer intents or budget updates.
2. **Analysis**: Internal "thoughts" focus on cryptographic validity and policy compliance.
3. **Action**: Issue `POST /invoke` calls with estimated costs and trace IDs.
4. **Validation**: Confirm received signatures match expected peer DIDs.

### Thought Stream Protocol
- Thoughts are emitted via `POST /thought`.
- They are broadcast live to the UI to provide "X-ray" visibility into the agent's internal state.
- **Defensive UI**: The frontend expects variable, unstructured, or malformed text from agents and uses error boundaries to prevent render failures.

---

## Verification & Compliance

### Dispute Packs
The system generates a **Dispute Pack** (JSON) for every trace:
- Contains all 3 handshake envelopes.
- Includes Merkle inclusion proofs (path + sibling hashes).
- Verifiable against the on-chain root in **Base Sepolia**.

### Trace ID Normalization
Always use the helper `stripId()` or equivalent to normalize `urn:uuid:` prefixes when matching traces between different data sources (SSE vs DB).

---

## Common Debugging Commands

```bash
# Watch live agent reasoning
docker compose logs -f bank-a-agent bank-b-agent

# Inspect SQLite in WAL mode
docker exec bank-b-proxy sqlite3 /data/bank-b.db "PRAGMA journal_mode;"

# Manually trigger the autonomous loop
curl -X POST http://localhost:3001/trigger
```
