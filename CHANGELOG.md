# Changelog - ikarin-develop Branch

## [Core Library Audit & D1 Security Fix] - 2026-05-19

### 🔒 Security
- **D1 Dual-Signing** (`@trustagentai/a2a-core`): `ExecutionEnvelope` is now signed by both Proxy A and Proxy B, closing the gap between the documented D1 non-repudiation invariant and the actual code. Both proxies hold an identical, cryptographically binding record of every execution.

### 🛠️ Build
- **tsconfig scope fix**: `src/proxy-server.ts` and `src/proxy-test.ts` (entry-point scripts) are now excluded from the TypeScript build. Previously they were compiled into `dist/` and shipped as part of the npm package.

### 📝 Documentation
- **CONTRIBUTING.md**: Replaced Rust/Cargo dev instructions (wrong language) with the correct Node.js/npm/tsc workflow. Added a dedicated roadmap section noting the Rust production runtime as a future target.
- **CONTRIBUTING.md**: Fixed git clone URL (was `YOUR_USERNAME` placeholder; now `kirbas`).
- **protocol_spec_v0.4.md**: Whitepaper clarified — Rust sidecar is an architectural goal, not the current implementation.
- **README.md**: Corrected `docs/` spec version reference (only v0.4 whitepaper exists).
- **envelopes.ts**: File header updated from v0.4 to v0.5.
- **trust-proxy.ts**: ProxyB validation order comment corrected to match code: `TTL → nonce → signature → budget`.
- **CLAUDE.md**: Added `GET /health` to the proxy-server endpoint table.

## [Autonomous Agent Integration & Production Hardening] - 2026-05-16

### 🚀 Real Autonomous Agents
- **Strands/AO Integration**: Transitioned from mock simulations to real autonomous agent runtimes in `Bank-A` and `Bank-B`.
- **Reasoning-Forward Loops**: Agents now perform internal reasoning before issuing tool calls, logging their logic directly to the live "Thought Stream."
- **Defensive UI Boundaries**: Implemented robust parsing boundaries in the React frontend to handle variable or unstructured agent outputs without crashing.

### 🛡️ Infrastructure & Performance
- **SQLite WAL Mode**: Configured all databases for **Write-Ahead Logging (`PRAGMA journal_mode = WAL;`)**, enabling high-frequency agent writes to occur simultaneously with active user reads.
- **Hybrid SSE Transport**: Unified thoughts and cryptographic signatures into a single real-time SSE pipeline, while ensuring parallel persistence to the SQLite ledger.
- **Trace Normalization**: Standardized `trace_id` formats as URN UUIDs across all distributed nodes for seamless forensic correlation.

### 📝 Documentation Overhaul
- **Comprehensive Update**: Rewrote `README.md`, `ARCHITECTURE.md`, `AGENT_CONTEXT.md`, and `AGENT_WORKFLOW.md` to reflect the latest production-ready architecture.
- **Verification Proofs**: Documented the construction and validation of compliance **Dispute Packs** containing Merkle inclusion proofs.

## [Merkle Notary Stabilization & UI v2] - 2026-05-05

### 🚀 New Features (Forensic UI & Protocol)
- **Forensic Detail Console**: Replaced raw JSON with a professional syntax-highlighted viewer. Collapsible sections for Signatures (amber), Hashes (purple), and Protocol fields (green).
- **Evidence Causal Chain**: New `EvidenceBundle` component visualizes the cryptographic link between [INTENT], [ACCEPTANCE], and [EXECUTION] envelopes.
- **Protocol Visualization**: Added a "Protocol" toggle to the ThoughtStream, enabling live, terminal-style monitoring of raw A2A envelope traffic.
- **Provenance Verifier**: Implemented native browser-based SHA-256 verification via drag-and-drop. Allows users to verify received files against anchored hashes locally.
- **Handshake Tutorial**: Added an interactive zero-state guide explaining the 3-phase A2A protocol flow to new users.
- **Bilateral Execution Badges**: Enhanced the handshake timeline with specific `EXECUTED (A)` and `EXECUTED (B)` status markers for non-repudiation.

### 🛡️ Resiliency & Architecture
- **RFC 8785 (JCS) Canonicalization**: Standardized all cryptographic hashing across Python and TypeScript services using JSON Canonicalization Scheme for cross-platform reproducibility.
- **Batched Anchoring**: Optimized the Merkle Notary service to support batched blockchain commits, significantly reducing transaction costs and L2 congestion.
- **Robust SSE Reconnection**: Implemented `while True` retry logic in the Bank-B agent and `useSSEMulti` in the frontend to handle container restarts gracefully.
- **SQLite Concurrency**: Added 5-second `SQLITE_BUSY` timeouts and file locks to manage shared database access between proxy services and the anchor sidecar.
- **Schema Optimization**: Removed legacy/redundant tables (`ledger_chain`, `risk_budgets`, `provenance`) to focus on the DAG-based ledger and RiskBudgetEngine.
- **Bank-A Auto-Retry**: Implemented automatic public key re-registration if the peer node loses ephemeral state.

### 🎨 UI/UX Improvements
- **Start Demo Relocation**: Relocated the autonomous demo trigger button to the header of the Bilateral Handshake component for improved visibility and logical flow.
- **BaseScan Link Fix**: Corrected the formatting of the blockchain explorer URL to properly point to the Base Sepolia `/address/` or `/tx/` path, ensuring the anchor links are clickable in the Handshake visualizer.
- **Trace Filtering**: Added a fast-filter dropdown to the Dispute Console for rapid navigation of high-volume trace histories.
- **Error Boundaries**: Wrapped critical dashboard panels in React Error Boundaries to display "Node Offline" alerts instead of application crashes.
- **Header Standardization**: Aligned all column headers (84px) and removed `urn:uuid:` prefixes for a cleaner, professional aesthetics.
- **BaseScan Integration**: Restored dynamic linking to Base Sepolia for all anchored transactions.

### 📝 Documentation
- **Architecture Synchronization**: Fully updated `ARCHITECTURE.md`, `README.md`, and `AGENT_CONTEXT.md` to reflect the D1 non-repudiation invariant and the new batched notary workflow.
