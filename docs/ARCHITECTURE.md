# Architecture — TrustAgentAI Distributed Handshake

## System Overview

TrustAgentAI has transitioned from a mock-based simulation to a production-ready distributed system featuring real autonomous agents (Strands/AO Agent) and a high-concurrency database layer.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Docker Network (bridge)                                            │
│                                                                     │
│  ┌──────────────┐    POST /invoke     ┌──────────────────────────┐ │
│  │ bank-a-agent │ ──────────────────► │      bank-a-proxy        │ │
│  │ (Strands/AO)  │    POST /thought    │   (TypeScript/Express)   │ │
│  │              │ ──────────────────► │   ProxyAGateway wrapper  │ │
│  │  Autonomous  │                     │   SQLite (WAL): bank-a.db│ │
│  │  Reasoning   │                     │   Hybrid SSE Stream      │ │
│  │  Loop        │                     │   POST /cross-check      │ │
│  │              │                     └────────────┬─────────────┘ │
│  └──────────────┘                                  │               │
│                                           POST /accept             │
│                                           POST /executed           │
│                                           POST /register-peer-key  │
│                                           GET /envelopes-by-trace  │
│                                                    │               │
│  ┌──────────────┐    SSE /events      ┌────────────▼─────────────┐ │
│  │ bank-b-agent │ ◄────────────────── │      bank-b-proxy        │ │
│  │  (Reactive)  │    POST /thought    │   (TypeScript/Express)   │ │
│  │              │ ──────────────────► │   ProxyBGateway wrapper  │ │
│  │  Verifies:   │                     │   SQLite (WAL): bank-b.db│ │
│  │  · Intents   │                     │   DAGLedger (Persistent) │ │
│  │  · Signatures│                     │   Hybrid SSE Stream      │ │
│  │  · Budgets   │                     └────────────┬─────────────┘ │
│  └──────────────┘                                  │               │
│                                           POST /anchor             │
│                                           GET /verify              │
│                                                    ▼               │
│  ┌──────────────────────────────────┐ ┌──────────────────────────┐ │
│  │           frontend               │ │     bank-b-anchor        │ │
│  │       (React + nginx)            │ │     (Python/Flask)       │ │
│  │  http://localhost:3000           │ │     L2 Notary Service    │ │
│  │                                  │ └──────────────────────────┘ │
│  │  · Real-time Thought Stream      │              ▲               │
│  │  · Handshake Visualizer          │              │               │
│  │  · Forensic Dispute Console      │◄─────────────┘               │
│  └──────────────────────────────────┘                              │
│                                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Infrastructure & Performance

### SQLite Write-Ahead Logging (WAL)
To support high-frequency agent operations, all SQLite databases are configured with **Write-Ahead Logging (WAL)**:
- **`PRAGMA journal_mode = WAL;`**: Enables simultaneous reads and writes. The UI can hydrate history and poll for updates while the agent is actively committing new handshake envelopes.
- **Busy Timeouts**: Configured with a 5-second `busy_timeout` to handle occasional locking during heavy Merkle batching operations.

### Hybrid Event Streaming
Data transport has evolved from simple REST polling to a **Hybrid Stream/Store** architecture:
1. **Agents** emit thoughts and lifecycle events via `POST /thought` or `POST /invoke`.
2. **Proxies** concurrently write these events to **SQLite** (for forensic audit) and broadcast them over **Server-Sent Events (SSE)** (for real-time UI updates).
3. **Frontend** uses `useSSE` hooks to maintain a live connection, falling back to database hydration only on initial load or connection reset.

---

## The Autonomous Handshake Protocol (v0.5)

The system enforces a 3-phase causal chain for every tool execution, ensuring non-repudiation and cryptographic alignment.

1. **INTENT**: Agent A initiates a tool call. The proxy wraps it in a signed envelope with a `trace_id` (URN UUID) and a JCS-canonicalized (RFC 8785) payload.
2. **ACCEPTANCE**: Bank B verifies the Ed25519 signature, checks the `NonceRegistry` for anti-replay, and enforces the `RiskBudgetEngine` policy. It returns a signed `AcceptanceReceipt`.
3. **EXECUTION**: Upon success, Bank B dual-signs the `ExecutionEnvelope`. Both parties now hold identical cryptographic proof of the outcome.
4. **PROVENANCE**: A `ContentProvenanceReceipt` is generated, cryptographically binding the tool output to the specific handshake trace.

---

## Real-Time Data Flow (The "Thought Stream")

Unlike static log files, the **Thought Stream** is a live reflection of the agent's internal reasoning loop:
- **Agent A (Initiator)**: Logs intent formation, signature generation, and verification of received receipts.
- **Agent B (Respondent)**: Logs policy evaluation, budget checking, and cryptographic commitment to the execution results.
- **UI Boundary**: The React frontend implements **Defensive Parsing Boundaries**. It gracefully handles unstructured or variable-length agent outputs, ensuring the render tree remains stable even if an agent "hallucinates" malformed JSON in its thought packets.

---

## Trace & Verification

### Unified Trace IDs
Distributed logs are unified via a `trace_id` formatted as a **URN UUID** (e.g., `urn:uuid:550e8400-e29b-41d4-a716-446655440000`). This ID follows the transaction from the first intent to the final blockchain anchor.

### Merkle Anchoring & Dispute Packs
- **Merkle Batching**: Bank-B's anchor service aggregates envelope signatures into a Merkle Tree.
- **L2 Notarization**: The Merkle Root is broadcast to **Base Sepolia** (Chain 84532) as a 0-ETH self-transaction.
- **Dispute Packs**: The system constructs a JSON bundle containing the full causal chain of envelopes plus Merkle inclusion proofs. This pack allows any third-party auditor to verify the entire transaction history against the on-chain root.

---

## API & Event Reference

Refer to the source code (`Bank-A/proxy/src/server.ts` and `Bank-B/proxy/src/server.ts`) for the full list of SSE events and HTTP endpoints.
