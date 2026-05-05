# Changelog - ikarin-develop Branch

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
- **Trace Filtering**: Added a fast-filter dropdown to the Dispute Console for rapid navigation of high-volume trace histories.
- **Error Boundaries**: Wrapped critical dashboard panels in React Error Boundaries to display "Node Offline" alerts instead of application crashes.
- **Header Standardization**: Aligned all column headers (84px) and removed `urn:uuid:` prefixes for a cleaner, professional aesthetics.
- **BaseScan Integration**: Restored dynamic linking to Base Sepolia for all anchored transactions.

### 📝 Documentation
- **Architecture Synchronization**: Fully updated `ARCHITECTURE.md`, `README.md`, and `AGENT_CONTEXT.md` to reflect the D1 non-repudiation invariant and the new batched notary workflow.
