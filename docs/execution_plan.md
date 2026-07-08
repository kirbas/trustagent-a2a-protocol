# Execution Plan — Dispute-Pack Hardening

**Audience:** an AI coding agent (any model) picking up execution cold.
**Companion doc:** [DISPUTE_HARDENING.md](DISPUTE_HARDENING.md) holds the *why* (threat model, decision rationale, residual risks). This file holds the *what to build, in what order, and how to know it's done*.

> Read [DISPUTE_HARDENING.md](DISPUTE_HARDENING.md) first. Do not re-litigate the decisions below — they are settled. If you believe one is wrong, raise it explicitly before changing course.

---

## 1. Mission

Harden where dispute packs (full transaction descriptions) are stored so the record proves *which AI agent did which action, on whose side, and when* — and survives a **collusion of both banks** against an external party (client/regulator).

Independent witness = **TrustAgentAI Cloud**, a co-signer outside both banks, semi-trusted **but verifiable** (its own log is append-only + anchored, so even it cannot silently rewrite history).

## 2. Settled decisions (reference)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Threat model | Both banks collude vs. external party |
| 2 | Third witness | TrustAgentAI Cloud as inline co-signer |
| 3 | Trust in witness | Semi-trusted but verifiable |
| 4 | Log structure | Per-party hash-chain (`seq` + `prev_hash`) + anchored checkpoints |
| 5 | Content store | Content-addressed WORM, cross-held (TrustAgentAI + client + banks) |
| 6 | Key custody | Persisted software keys, encrypted at rest, KEK isolated from DBA |
| 7 | Anchor topology | TrustAgentAI-centric checkpoint (MVP) |
| 8 | Co-sign path | Sync inline + degraded-mode fallback |
| 9 | Degraded mode | On-chain heartbeat + reconciliation window + value cap |
| 10 | Key registry | TrustAgentAI key-transparency, rotations endorsed by prior key |
| 11 | Content access | Envelope-encryption, per-tx DEK + regulator escrow (escrow NOT held by TrustAgentAI) |

## 3. Repository orientation

Monorepo, three runtime languages:

- **`trust-agent/`** — TypeScript core library (`@trustagentai/a2a-core`). Holds crypto ([src/crypto.ts](../trust-agent/src/crypto.ts)) and envelope builders ([src/envelopes.ts](../trust-agent/src/envelopes.ts)). The proxies depend on it via `file:../../trust-agent`.
- **`Bank-A/proxy/`, `Bank-B/proxy/`** — TypeScript/Express proxies. ESM (`"type":"module"`), `better-sqlite3` (WAL). Entry: `src/server.ts`. Persistence: `src/db.ts`. Build: `npm run build` (tsc) → `dist/`. Start: `npm start`.
- **`Bank-B/merkle-anchor/`** — Python/Flask notary. Builds Merkle tree ([domain/merkle.py](../Bank-B/merkle-anchor/domain/merkle.py)), anchors to Base Sepolia ([infra/notary.py](../Bank-B/merkle-anchor/infra/notary.py)), reads the shared SQLite via Docker volume.
- **`frontend/`** — React + nginx. Dispute console: `src/components/DisputeConsole.tsx`.
- **`docker-compose.yml`** — wires bank-a-agent, bank-a-proxy, bank-b-agent, bank-b-proxy, bank-b-anchor, frontend.

**Current key API** ([trust-agent/src/crypto.ts](../trust-agent/src/crypto.ts)):
```ts
export interface KeyPair { privateKey: Uint8Array; publicKey: Uint8Array; kid: string; }
export async function generateKeyPair(kid: string): Promise<KeyPair>
```
~~Keys are generated fresh at boot~~ — **resolved in Delta #1**: both proxies and the witness now load a durable Ed25519 identity via `loadOrCreateKeyPair(kid, keystorePath, kek)` from an encrypted (AES-256-GCM) keystore, KEK from env (`KEYSTORE_PATH`/`KEYSTORE_KEK`), fail-fast when absent.

### Test infrastructure (stood up)
**Vitest** in `trust-agent/` and `trust-agent-cloud/` (`npm test`, `npm run test:coverage`, 80% threshold in `vitest.config.ts` — add new modules to `coverage.include`). **pytest** in `Bank-B/merkle-anchor/` (`python3 -m pytest`, `pyproject.toml`, `requirements-dev.txt`). The bank proxies still delegate their tested logic to `@trustagentai/a2a-core`; keep new pure logic there.

## 4. Working agreement (non-negotiable)

- **TDD.** RED → GREEN → REFACTOR. Write the failing test first, then the minimal implementation. Confirm the test failed before implementing.
- **Coverage ≥ 80%** on new/changed modules.
- **No secrets in source.** Keys, KEKs, RPC keys, escrow keys → environment / secret store only. The `.env` is gitignored; never commit real key material.
- **Immutability & small files** (≤ ~400 lines/file, ≤ ~50 lines/function). New objects over mutation.
- **Conventional commits** (`feat:`, `test:`, `refactor:`, `docs:`, `chore:`). Attribution is disabled globally.
- **Branch, never `main`.** One branch per delta, e.g. `feat/delta-1-durable-keys`. Open a PR; do not self-merge to main.
- **Preserve wire compatibility.** Envelope JSON shape, `signed_digest` rule (`SHA-256(JCS(envelope − signatures))`), and existing SSE event names must not break unless a delta explicitly changes them.

## 5. Delta backlog (execute in order — each unblocks the next)

### Delta #1 — Durable, custodied keys  ✅ DONE (PR #18, merged to main)
**Objective:** proxies load a persistent Ed25519 identity from an **encrypted keystore** instead of minting a new key every boot. KEK comes from a secret separate from the DB.

- **Files:** [trust-agent/src/crypto.ts](../trust-agent/src/crypto.ts) (add keystore fns), [Bank-A/proxy/src/server.ts:34](../Bank-A/proxy/src/server.ts#L34), [Bank-B/proxy/src/server.ts:84](../Bank-B/proxy/src/server.ts#L84).
- **Tasks:**
  1. Stand up Vitest in `trust-agent/` (and a shared config the proxies can reuse).
  2. Add `loadOrCreateKeyPair(kid, keystorePath, kek): Promise<KeyPair>`: if the keystore file exists, decrypt & load; else generate, encrypt, persist, return. Encryption: AES-256-GCM over the 32-byte private key, KEK from env (`KEYSTORE_KEK`), random IV, authenticated. Store `{ kid, publicKey(hex), iv, ciphertext, tag }` as JSON.
  3. Replace `generateKeyPair(PROXY_KID)` at both proxy boots with `loadOrCreateKeyPair(...)`, reading `KEYSTORE_PATH` and `KEYSTORE_KEK` from env.
  4. Keystore file path under the existing data volume; **KEK must NOT be derivable from anything the DB admin can read.**
- **Acceptance criteria:**
  - Restarting a proxy yields the **same** public key (assert across two `loadOrCreateKeyPair` calls).
  - Wrong/absent KEK → decryption fails loudly (no silent fallback to a new key).
  - Private key bytes never appear in logs or in the SQLite DB.
  - Missing `KEYSTORE_KEK` at boot → process exits with a clear error (fail-fast).
- **Tests (write first):** same-key-on-reload; tamper-ciphertext → auth failure; wrong-KEK → failure; new keystore created when absent; env-missing → fail-fast.
- **Residual note:** software keys are a knowingly-accepted compromise (see DISPUTE_HARDENING §5.1). The KEK-isolation requirement is what makes it meaningful — do not shortcut it.

### Delta #2 — Append-only hash-chain  ✅ DONE (PR #19, merged to main)
Add `seq` (monotonic per party) + `prev_hash` to the `envelopes` table; on write, link each row to the previous head; expose a chain-verify function (no gaps, links intact).
→ Shared module [trust-agent/src/hash-chain.ts](../trust-agent/src/hash-chain.ts) (`GENESIS_PREV_HASH`, `computeRowHash`, `verifyChain`, `ChainRow`); [Bank-A/proxy/src/db.ts](../Bank-A/proxy/src/db.ts), [Bank-B/proxy/src/db.ts](../Bank-B/proxy/src/db.ts) link rows + backfill. `GET /verify-chain` on both proxies.

### Delta #3 — TrustAgentAI inline co-sign service (new)  ✅ DONE (PR #20, open — branch `feat/delta-3-cosign`)
New service co-signing between handshake Phase 2 and Phase 3; maintains its own hash-chain; gates finality. Wire into `ProxyAGateway`.
→ Service [trust-agent-cloud/](../trust-agent-cloud/) (own durable key, own `cosigns` chain, `POST /co-sign`, `POST /register-key`, `GET /verify-chain`); pure logic [trust-agent/src/co-sign.ts](../trust-agent/src/co-sign.ts); `ProxyAGateway.witnessEndpoint` gates finality (`_a2a.cosign_receipt`, `ERR_WITNESS_UNAVAILABLE`). **Reusable as a cross-holder for Delta #5.**

### Delta #4 — Checkpoint anchoring + heartbeat  ✅ DONE (PR #21, open — stacked on #20, branch `feat/delta-4-anchoring`)
Anchor the per-party chain **HEAD checkpoint** (not an arbitrary signature batch); add a periodic signed on-chain heartbeat publisher for degraded-mode detection.
→ [domain/checkpoint.py](../Bank-B/merkle-anchor/domain/checkpoint.py), [domain/heartbeat.py](../Bank-B/merkle-anchor/domain/heartbeat.py), [app/checkpoint_agent.py](../Bank-B/merkle-anchor/app/checkpoint_agent.py); endpoints `POST /checkpoint`, `POST /heartbeat`, `GET /checkpoints|/heartbeats`; opt-in periodic publisher (`HEARTBEAT_ENABLED`). Checkpoints Bank-B's chain today; `party`-parameterized so the witness `cosigns` chain is a small follow-up.

### Delta #5 — WORM content store + envelope-encryption  ← NEXT (branch `feat/delta-5-worm`, stacked on #4)
**Objective:** stop discarding the plaintext. Today `args`/`outputData` are *"hashed, NOT stored"* — only `args_hash`/`output_hash` live in envelopes ([envelopes.ts](../trust-agent/src/envelopes.ts): `payload.args_hash = sha256Json(args)`, `result.output_hash = sha256Json(outputData)`; "will be hashed, NOT stored" comments). Persist them as **encrypted, content-addressed WORM blobs**, cross-held so *what* happened survives a two-bank collusion, and stays confidential (DISPUTE §4/§5, Decisions #5 & #11).

- **Settled design (do not re-open):**
  - **Content-addressed WORM:** blob id = `sha256(plaintext)` = the commitment already in the envelope (**DoD #1**). Write-once: same content → idempotent; different content under the same id → rejected.
  - **Per-tx DEK:** random 256-bit key per transaction, AES-256-GCM over the content (reuse the AES-GCM pattern in [crypto.ts](../trust-agent/src/crypto.ts)).
  - **Envelope-encryption:** wrap the DEK under each holder's KEK. Holders = TrustAgentAI (witness), client, banks.
  - **Regulator escrow:** a separate escrow-wrapped DEK the **regulator** can unwrap and TrustAgentAI **cannot** — escrow key is NOT held by the witness (DISPUTE §5.4). Model the regulator as an independent holder/KEK.
  - **Cross-push:** after local WORM write, push the encrypted blob to ≥1 other holder (witness `trust-agent-cloud` + a "client" store).
  - **Bind into chain:** the content commitment is already in the envelope; ensure the WORM blob reconciles with it and `verifyChain` stays valid. Encryption/storage is **additive** — do not break envelope wire shape or `signed_digest`.
- **Build:** pure crypto/content-addressing modules in [trust-agent/src](../trust-agent/src) (DEK gen, encrypt/decrypt, wrap/unwrap per holder, escrow-wrap, id==commitment check), exported from `@trustagentai/a2a-core`; a WORM blob store + `PUT/GET /blob/:contentHash` on the witness (ciphertext + wrapped-DEKs only, never plaintext/keys) and locally in the proxies; wire into Bank-A `/invoke`; holder/escrow KEKs as env placeholders in `.env.example` (real in gitignored `.env`).
- **Acceptance criteria:**
  - Plaintext stored as an encrypted content-addressed blob; `sha256(plaintext)` == the envelope's `args_hash`/`output_hash` (**DoD #1**).
  - Per-tx DEK; envelope-encryption; regulator escrow present and **NOT** held by TrustAgentAI (§5.4).
  - Content cross-held (TrustAgentAI + client, minimum).
  - Logs/SQLite contain only ciphertext + wrapped DEKs — never plaintext content or bare keys/DEK.
  - Existing happy-path works; builds green in `trust-agent/`, `trust-agent-cloud/`, both proxies; coverage ≥80% on new modules.
- **Tests (write first):** encrypt↔decrypt round-trip; tamper ciphertext / wrong DEK → GCM auth failure; content-address == commitment (DoD #1); wrap/unwrap under holder KEK round-trip, wrong KEK fails; escrow unwraps for the regulator but not for the witness; WORM write-once (idempotent same-content, reject different-content); cross-hold on ≥2 holders; `verifyChain` still valid.

### Delta #6 — Key-transparency registry
Replace mutable `register-peer-key` with an append-only, anchored registry: validity windows, revocation-as-append, rotations endorsed by the prior key.
→ [Bank-A/proxy/src/key-exchange.ts](../Bank-A/proxy/src/key-exchange.ts).

### Delta #7 — Degraded-mode discipline
Heartbeat-gap detection, reconciliation window (co-sign within N or auto-flag invalid), value/rate cap on degraded transactions.

## 6. Definition of done (whole program)

An external auditor can run all five checks and any tamper/deletion/fabrication/suppression breaks at least one:

1. **Content** — WORM blob `sha256` matches the envelope commitment.
2. **Envelope** — Ed25519 verifies under the key the registry shows valid *at that timestamp*.
3. **Continuity** — `prev_hash` links unbroken; no `seq` gaps between anchored checkpoints.
4. **Anchor** — checkpoint HEAD on Base Sepolia; heartbeat sequence intact around tx time.
5. **Witness** — inline TrustAgentAI co-signature present (or a valid, capped, reconciled degraded record).

## 7. Handoff status

- Design: **accepted** (this doc + DISPUTE_HARDENING.md).
- Progress (as of 2026-07-08): **all 7 deltas complete.**
  - **Delta #1** durable keys — ✅ merged (PR #18).
  - **Delta #2** hash-chain — ✅ merged (PR #19).
  - **Delta #3** inline co-sign witness — ✅ merged (PR #20).
  - **Delta #4** checkpoint + heartbeat — ✅ merged (PR #21).
  - **Delta #5** WORM + envelope-encryption — ✅ merged (PR #22).
  - **Delta #6** key-transparency registry — ✅ merged (PR #23).
  - **Delta #7** degraded-mode discipline — ✅ merged (PR #24).
- **Branch stack (historical):** `main` → #20 `feat/delta-3-cosign` (also absorbed #21–#24 as later PRs targeted it directly) → `feat/delta-5-worm` (#22) / `feat/delta-6-key-transparency` (#23) / `feat/delta-7-degraded-mode` (#24). `feat/delta-3-cosign` now contains the full backlog and is the integration branch pending a final merge to `main`.
- **Verification harness:** `docs/testing/E2E_ANTIGRAVITY_PROMPT.md` exercises the full stack — Parts 1–3f cover Deltas #1–7, Part 4/4b covers the pre-existing + Delta #4 anchor pipeline. A combined live run (all 7 deltas on one stack) was exercised 2026-07-08: real transaction → witness co-sign → WORM DoD #1 → key-history bootstrap → forced degraded fallback → reconciliation, all hash-chains valid throughout.
- **Next action:** none from this doc's backlog — all deltas implemented. Remaining work is operational: merge the integration branch to `main`, and the residual risks disclosed per-delta (see each PR) are the honest boundary of this MVP, not open implementation items.
