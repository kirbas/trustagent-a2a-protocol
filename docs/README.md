# TrustAgentAI — Autonomous Procurement Handshake

A production-grade demonstration of the **A2A Accountability Protocol**. This demo features real, live autonomous agents performing cryptographically binding handshakes on a tamper-evident ledger.

---

## 🚀 Quick Start

1. **Clone and Configure**:
   ```bash
   git clone <repo>
   cd Trust-Agent
   # Add RPC_URL and PRIVATE_KEY to .env for blockchain anchoring (optional)
   ```

2. **Launch Infrastructure**:
   ```bash
   docker compose up --build
   ```

3. **Trigger the Loop**:
   Open **[http://localhost:3000](http://localhost:3000)** and click the **🚀 START DEMO** button in the header.

---

## 🏗 Key Architectural Pillars

### 1. Real Autonomous Agents
The system has transitioned from mock simulations to real **Strands/AO Agent** runtimes. Agents autonomously negotiate procurement scenarios, emit real-time "Thought Streams," and handle cryptographic signing in-loop.

### 2. SQLite with WAL (Write-Ahead Logging)
High-concurrency is achieved via SQLite's WAL mode. Handshake records are written to the ledger simultaneously with real-time UI hydration, eliminating database locking issues during intensive agent activity.

### 3. Hybrid SSE/DB Streaming
Live agent reasoning and protocol events are broadcast via **Server-Sent Events (SSE)** for zero-latency visualization, while being concurrently persisted to the SQLite ledger for permanent forensic audit.

---

## 🎨 Visualizer Features

### Agent Thought Stream (Left)
- **Live Reasoning**: X-ray visibility into the agent's internal reasoning loop.
- **Protocol Mode**: Terminal-style view of raw cryptographic envelope traffic.
- **Defensive Parsing**: React boundaries protect the UI from malformed or unstructured agent outputs.

### Bilateral Handshake (Center)
- **Trace Timelines**: Real-time visualization of the 3-phase handshake (Intent → Acceptance → Execution).
- **L2 Anchoring**: Watch as transactions are batched, Merkle-hashed, and anchored to **Base Sepolia**.
- **Blockchain Links**: Direct links to **BaseScan** for every anchored transaction.

### Forensic Dispute Console (Right)
- **Dispute Packs**: Download full forensic bundles containing signed records and Merkle inclusion proofs.
- **Provenance Verifier**: Drag-and-drop tool outputs to verify their integrity against the anchored content hash.
- **Cross-Check**: Validate that both Bank-A and Bank-B hold identical records for any given trace.

---

## 🛡 Security & Compliance
- **RFC 8785 (JCS)**: Deterministic JSON canonicalization for all hashing.
- **Ed25519 Signatures**: Every record is signed by the originating node's proxy.
- **Merkle Proofs**: Mathematical proof that a specific transaction was included in a blockchain-anchored batch.

---

## 📝 Documentation
- **[ARCHITECTURE.md](ARCHITECTURE.md)**: Detailed system design and data flow.
- **[AGENT_CONTEXT.md](AGENT_CONTEXT.md)**: Critical technical context for developers and AI agents.
- **[CHANGELOG.md](../CHANGELOG.md)**: Recent updates and version history.
