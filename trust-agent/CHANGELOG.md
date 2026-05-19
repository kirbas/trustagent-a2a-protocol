# Changelog

## v0.5.1 (2026-05-19)

### Security
- **D1 Dual-Signing implemented**: `ExecutionEnvelope` is now signed by both Proxy A (on creation) and Proxy B (counter-signature via `handleExecution`). Previously the envelope was stored with zero signatures, leaving the D1 non-repudiation invariant unimplemented. Both signatures cover the canonical JCS hash per §4 Hash Target Rule.

### Fixed
- `proxy-server.ts` `/executed` endpoint now returns `{ execution: <dual-signed> }` instead of `{ ok: true }`, so Proxy A holds the identical binding record as Proxy B.
- ProxyB validation order comment in `trust-proxy.ts` corrected: was `nonce → TTL`; actual code (and CLAUDE.md) has always been `TTL → nonce → signature → budget`. Added inline rationale (TTL is stateless; nonce-consume is stateful).
- `tsconfig.json` now explicitly excludes `src/proxy-server.ts` and `src/proxy-test.ts`. Previously `include: ["src/**/*"]` compiled them into `dist/`, causing them to be published as part of the npm package.
- `envelopes.ts` file header updated from v0.4 to v0.5 — all envelope types already used `spec_version: "0.5"`.
- `README.md` `docs/` description corrected: only a v0.4 whitepaper exists; v0.5 is reflected in source code.
- `CONTRIBUTING.md` development environment replaced Rust/Cargo instructions with the correct Node.js/npm/tsc workflow.
- `CONTRIBUTING.md` git clone URL replaced placeholder `YOUR_USERNAME` with actual repo owner `kirbas`.
- `docs/protocol_spec_v0.4.md` whitepaper clarified: Rust sidecar is a future production target, not the current implementation.

## v0.5.0 (2026-04-29)
### Added
- Content Provenance layer: ContentProvenanceReceipt (hash-only)
- Ledger support for PROVENANCE_RECORD

### Changed
- spec_version bumped to 0.5 for Intent/Acceptance/Execution envelopes
- Example updated to include provenance step

## v0.4.0
- Handshake 3+1: Intent / Acceptance / Execution (+ optional Ack)
- JCS hash target rule, anti-replay, streaming DAG ledger, Merkle batching
