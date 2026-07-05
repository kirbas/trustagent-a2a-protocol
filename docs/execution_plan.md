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
Keys are generated fresh at boot in `server.ts` and never persisted — this is the target of Delta #1.

### ⚠ Test infrastructure gap
The proxies have **no test runner** (`package.json` scripts are only `build`/`start`). Delta #1 must **stand up a test harness first**. Recommended: **Vitest** (native ESM + TS, works with the existing tsconfig). Add `"test"` and `"test:coverage"` scripts. This is a prerequisite, not optional — the working agreement below mandates TDD.

## 4. Working agreement (non-negotiable)

- **TDD.** RED → GREEN → REFACTOR. Write the failing test first, then the minimal implementation. Confirm the test failed before implementing.
- **Coverage ≥ 80%** on new/changed modules.
- **No secrets in source.** Keys, KEKs, RPC keys, escrow keys → environment / secret store only. The `.env` is gitignored; never commit real key material.
- **Immutability & small files** (≤ ~400 lines/file, ≤ ~50 lines/function). New objects over mutation.
- **Conventional commits** (`feat:`, `test:`, `refactor:`, `docs:`, `chore:`). Attribution is disabled globally.
- **Branch, never `main`.** One branch per delta, e.g. `feat/delta-1-durable-keys`. Open a PR; do not self-merge to main.
- **Preserve wire compatibility.** Envelope JSON shape, `signed_digest` rule (`SHA-256(JCS(envelope − signatures))`), and existing SSE event names must not break unless a delta explicitly changes them.

## 5. Delta backlog (execute in order — each unblocks the next)

### Delta #1 — Durable, custodied keys  ← START HERE
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

### Delta #2 — Append-only hash-chain
Add `seq` (monotonic per party) + `prev_hash` to the `envelopes` table; on write, link each row to the previous head; expose a chain-verify function (no gaps, links intact).
→ [Bank-A/proxy/src/db.ts](../Bank-A/proxy/src/db.ts), [Bank-B/proxy/src/db.ts](../Bank-B/proxy/src/db.ts). Migration must handle existing rows.

### Delta #3 — TrustAgentAI inline co-sign service (new)
New service co-signing between handshake Phase 2 and Phase 3; maintains its own hash-chain; gates finality. Wire into `ProxyAGateway`.

### Delta #4 — Checkpoint anchoring + heartbeat
Anchor the per-party chain **HEAD checkpoint** (not an arbitrary signature batch); add a periodic signed on-chain heartbeat publisher for degraded-mode detection.
→ [Bank-B/merkle-anchor/app/accounting_agent.py](../Bank-B/merkle-anchor/app/accounting_agent.py), [infra/notary.py](../Bank-B/merkle-anchor/infra/notary.py), [domain/merkle.py](../Bank-B/merkle-anchor/domain/merkle.py).

### Delta #5 — WORM content store + envelope-encryption
Persist plaintext args/output as encrypted, content-addressed blobs (per-tx DEK); cross-push to TrustAgentAI + client; bind content hash into the chain. Today these are *"hashed, NOT stored"* ([envelopes.ts:23](../trust-agent/src/envelopes.ts#L23)).

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
- Code: **not started.** Next action = Delta #1 on branch `feat/delta-1-durable-keys`.
