# Changelog

## v0.6.0 (2026-07-08)

### Added
- `worm.ts` / `worm-store.ts` (Delta #5): DEK generation, content-addressing (`contentAddress`/`canonicalBytes` — id `== sha256Json(value)`), AES-256-GCM encrypt/decrypt, per-holder DEK wrap/unwrap, `buildWormRecord`/`decryptWormRecord` (regulator escrow entry), `WormBlobStore` (write-once: idempotent on identical re-put, rejects a differing one).
- `key-registry.ts` (Delta #6): `KeyRegistry` — append-only key-transparency. First registration per DID is trust-on-first-use; every later one is a rotation requiring an endorsement signed by the prior key. `revoke()` closes a validity window without deleting history. `resolveAt(did, timestamp)` answers "which key was valid then" for audit.
- `degraded-mode.ts` (Delta #7): `DegradedModeGate` (value cap + rolling-window rate cap on witness-outage fallbacks), `buildDegradedRecord`, `reconciliationStatus` (pure PENDING/RECONCILED/EXPIRED_UNRECONCILED).
- `ProxyBConfig.proxyAPublicKeys` widened to a `PublicKeySource` interface (`{ get(kid) }`) so `KeyRegistry` is a structural drop-in for the old `Map`.
- `ProxyAConfig` gains an optional `degradedMode` gate; a witness failure now falls back to a capped `degraded_record` instead of always hard-failing, when configured.

### Coverage
- New modules all ≥94% stmt/branch/func/line; `degraded-mode.ts` and `blob-db.ts`-equivalent pure logic at 100%.

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
