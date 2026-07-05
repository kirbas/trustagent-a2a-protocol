# Dispute-Pack Hardening — Design Record

**Status:** Accepted (design) · **Scope:** Where dispute packs and full transaction descriptions live, and how we make them tamper-evident against a colluding-banks adversary.

**Core goal of the system:** prove *which AI agent performed which action, on whose side, and when*, in a payments context — such that the record survives a hostile database administrator.

This document has two blocks:
- **Block 1 — For the Team** — the engineering decision record: threat model, resolved decisions, defense-in-depth map, residual risks, and the implementation delta order.
- **Block 2 — For the Pitch** — the investor-facing narrative of why this is defensible.

---

# Block 1 — For the Team (Engineering Decision Record)

## 1. The problem we started from

Today the chain anchors **only a hash** of each dispute pack; the packs themselves — the full transaction description — live in **Bank-A's and Bank-B's SQLite**. The stated fear: *"a DB admin at either bank can edit the stored data, and proving anything afterwards is hard."*

First correction, because it reframes everything:

> A naive **row edit is already detectable.** SQL stores the signed `raw_payload`, whose content is committed by hash (`args_hash`, `output_hash`, `intent_hash`). The chain is *on-chain Merkle root → sha256(signature) → Ed25519 signature → content hash*. Edit the payload and the signature no longer verifies; edit the signature and the Merkle proof no longer reconciles to the anchored root. Signatures already stop an outsider **without the key**.

The residual holes are elsewhere, and they are what this design closes:

| Hole | Why signatures don't cover it |
|------|-------------------------------|
| **Self-fabrication** | Keys are generated in-proxy at boot (`generateKeyPair`) and fully held by the bank. The key-holder can mint or re-sign records. |
| **Deletion / suppression** | The on-chain root doesn't enumerate what *should* exist. A dropped row / un-anchored transaction leaves no trace. |
| **Content unavailability** | Plaintext args/output are *"hashed, NOT stored"*. A pack proves a commitment existed, not *what* it said. |
| **Identity repudiation** | `register-peer-key` is mutable; a party can later claim *"that wasn't my key."* |
| **Anchoring asymmetry** | Only Bank-B anchors, in arbitrary batches, on demand — Bank-A's history depends on B's honesty, with an unbounded pre-anchor window. |

## 2. Threat model (the load-bearing choice)

**Adversary: both banks colluding against an external party (client / regulator).** We tolerate collusion of the two settlement parties and still keep the record provable.

Consequence, stated plainly: **in a pure two-party system this is impossible without a third independent key.** The blockchain anchor alone only defeats *post-hoc* rewriting and fixes *ordering/time*; two parties colluding *at creation time* can build an internally consistent fake history and anchor that. So the design **requires a witness outside both banks.**

## 3. Resolved decisions

| # | Decision | Choice | Threat it closes |
|---|----------|--------|------------------|
| 1 | Threat model | Both banks collude vs. external party | sets the bar |
| 2 | Third witness | **TrustAgentAI Cloud** as co-signer | bank collusion ≠ sufficient |
| 3 | Trust in witness | Semi-trusted **but verifiable** | don't just relocate the problem |
| 4 | Log structure | **Per-party hash-chain + checkpoints** | deletion / reorder / suppression |
| 5 | Content store | **Content-addressed WORM**, cross-held (TrustAgentAI + client + banks) | *what* survives collusion |
| 6 | Key custody | **Persisted software keys** (encrypted at rest), KEK isolated from DBA | admin ≠ signer, durable identity |
| 7 | Anchor topology | **TrustAgentAI-centric checkpoint** (MVP) | tamper-evidence of order/time |
| 8 | Co-sign path | **Sync inline** + degraded-mode fallback | suppression-at-origin |
| 9 | Degraded mode | **On-chain heartbeat + reconciliation window + value cap** | the availability escape-hatch |
| 10 | Key registry | **TrustAgentAI key-transparency**, rotations endorsed by prior key | *whose* key / repudiation |
| 11 | Content access | **Envelope-encryption**, per-tx DEK + regulator **escrow** | confidentiality at dispute time |

**"When" is derived, not a separate mechanism:** the authoritative timestamp is TrustAgentAI's co-signature (it sits on the critical path), bounded above by the anchor block time and the on-chain heartbeat. No separate RFC-3161 TSA required.

## 4. Defense-in-depth map — layer → threat

Each layer closes exactly one class; none is asked to do another's job.

- **Ed25519 signature** → *tampering* (row edits).
- **Per-party hash-chain (`seq` + `prev_hash`) + anchored checkpoints** → *deletion, reorder, suppression* (a gap between two anchored checkpoints is provable).
- **Independent inline co-signer (TrustAgentAI) + key-transparency registry** → *fabrication* (a hidden or forged transaction cannot produce a valid witness signature).
- **Checkpoints + on-chain heartbeat** → *"when"* (monotonic public time; ordering cannot be rewound).
- **WORM content store + envelope-encryption with escrow** → *"what"* (the pre-image is available and confidential).
- **Bounds on the escape hatches** (degraded cap, escrow quorum, checkpoint cadence) → keep the known SPOFs small rather than pretending they don't exist.

## 5. Residual risks — knowingly accepted

These are **explicit trade-offs**, not oversights. A reviewer/regulator should see them stated.

1. **Software keys, not HSM.** An admin with host/process access can exfiltrate a key and append fabrications. This is bounded — not eliminated — by checkpoint cadence + cross-holding, and it rests on **KEK isolation** (the decryption key must live in a separate secret store, under a role that does not overlap DBA — otherwise "encrypted at rest" is theatre). *Upgrade path: KMS/HSM non-extractable keys; threshold/MPC for the high-value TrustAgentAI key.*
2. **TrustAgentAI-centric anchoring (not mutual).** TrustAgentAI is a **liveness dependency** on the critical path — a hard availability SPOF. Ordering guarantees hold only while the heartbeat runs. *Upgrade path: mutual anchoring — each party anchors its own chain HEAD.*
3. **Semi-trusted witness.** "Both banks collude" is closed. **"TrustAgentAI + one bank collude" is NOT closed** — that coalition can fabricate. This is the central trust compromise of the MVP and must be disclosed.
4. **Escrow key is a trust concentration.** Whoever holds escrow can decrypt everything. **Escrow must not sit with TrustAgentAI** (else "witness + escrow = silent omniscience over all payments"). Holder = the regulator, or a threshold quorum (regulator + 1 party).

## 6. Implementation delta order (grounded in current code)

Ordered by dependency; #1 unblocks the rest.

1. **Durable keys.** Replace boot-time `generateKeyPair(PROXY_KID)` with load-or-create from an encrypted keystore; KEK from a separate secret store.
   → [Bank-A/proxy/src/server.ts:34](../Bank-A/proxy/src/server.ts#L34), [Bank-B/proxy/src/server.ts:84](../Bank-B/proxy/src/server.ts#L84), [trust-agent/src/crypto.ts](../trust-agent/src/crypto.ts)
2. **Hash-chain.** Add `seq` + `prev_hash` to the `envelopes` table; enforce append-only linkage on write.
   → [Bank-A/proxy/src/db.ts](../Bank-A/proxy/src/db.ts), [Bank-B/proxy/src/db.ts](../Bank-B/proxy/src/db.ts)
3. **TrustAgentAI co-sign service (new).** Inline endpoint between Phase 2 and Phase 3; co-signs, appends to its own hash-chain, gates finality. Wire into the handshake in `ProxyAGateway`.
4. **Checkpoint anchoring + heartbeat.** Anchor the per-party chain HEAD checkpoint (not an arbitrary signature batch); add a periodic signed on-chain heartbeat publisher.
   → [Bank-B/merkle-anchor/app/accounting_agent.py](../Bank-B/merkle-anchor/app/accounting_agent.py), [Bank-B/merkle-anchor/infra/notary.py](../Bank-B/merkle-anchor/infra/notary.py), [Bank-B/merkle-anchor/domain/merkle.py](../Bank-B/merkle-anchor/domain/merkle.py)
5. **WORM content store + envelope-encryption.** Persist plaintext args/output as encrypted, content-addressed blobs (per-tx DEK); cross-push to TrustAgentAI + client. Bind the content hash into the chain. Today these are *"hashed, NOT stored"*.
   → [trust-agent/src/envelopes.ts:23](../trust-agent/src/envelopes.ts#L23)
6. **Key-transparency registry.** Replace mutable `register-peer-key` with an append-only, anchored registry: validity windows, revocation as an append event, rotations endorsed by the prior key.
   → [Bank-A/proxy/src/key-exchange.ts](../Bank-A/proxy/src/key-exchange.ts)
7. **Degraded-mode discipline.** Detect heartbeat gaps, enforce a reconciliation window (co-sign within N or auto-flag invalid) and a value/rate cap on degraded transactions.

## 7. Verification (what an auditor runs)

A third party proves the full chain end-to-end without trusting any single party:

1. **Content:** fetch the WORM blob by content hash → `sha256` matches the value committed in the envelope.
2. **Envelope:** each envelope's Ed25519 signature verifies under the key that the **key-transparency registry** shows valid at that envelope's timestamp.
3. **Continuity:** `prev_hash` links form an unbroken chain; `seq` has no gaps between two anchored checkpoints.
4. **Anchor:** the checkpoint HEAD is present on Base Sepolia; the heartbeat sequence has no unexplained gap around the transaction time.
5. **Witness:** the transaction carries TrustAgentAI's inline co-signature (or a valid, capped, reconciled degraded record).

Any tamper, deletion, fabrication, or suppression breaks at least one of these five checks.

---

# Block 2 — For the Pitch

## The one-liner

**We make it impossible for a bank to secretly rewrite what an AI agent did with your money — even if two banks conspire to do it together.**

## The problem

AI agents are starting to move money on our behalf. When something goes wrong, one question decides everything: *which agent did what, on whose side, and when?* Today that record lives inside each bank's own database. Whoever administers that database can quietly change it — and once the record is changed, there is no independent way to prove what it originally said. "Trust us, our logs are correct" is not an answer a regulator, a court, or a defrauded customer can accept.

## The insight

Cryptographic signatures already stop an *outsider* from tampering. The hard part is the *insider* — and the truly hard part is **two insiders who agree to lie together.** You cannot solve that with two parties alone; someone with no stake in the lie has to be in the loop at the moment the transaction happens.

So we split authority:

- **The bank** proves it *settled* the payment.
- **TrustAgentAI** — independent of both banks — proves *which agent requested it, and when*, by co-signing the transaction **inline, before it can complete.**

Neither side can forge the other's half. A transaction that skips our witness simply isn't a valid transaction — there's nothing to point to. That single move turns "trust each bank's database" into "no bank, and no pair of banks, can fabricate, alter, or hide a record without it being provable."

## What makes it credible (not just a claim)

- **Public, permanent timeline.** Every batch of records is anchored to a public blockchain (Base Sepolia). The order of history is fixed and cannot be rewound.
- **Deletion becomes visible.** Records are chained and numbered; a missing entry leaves a provable gap — you can't quietly drop a transaction.
- **The evidence itself survives.** The full transaction description is stored tamper-evidently and held by more than one party, encrypted, so it's still there — and still confidential — when a dispute arises.
- **We hold ourselves accountable too.** Our own witness log is append-only and anchored, so even we can't rewrite it after the fact. A regulator gets a sealed key to open the specific records in dispute — and nothing more.

## The honest edge (why this reads as real, not hand-wavy)

We are explicit about the trust boundary: today the strong guarantee is *"no bank, or pair of banks, can cheat."* Removing us as a trusted party entirely — the fully decentralized version — is on the roadmap (hardware key custody, mutual anchoring, threshold escrow). We ship the layer that closes the threat customers actually face now, and we've mapped exactly how each remaining assumption gets retired.

## Why now

Agent-driven payments are arriving before the accountability layer for them exists. The winner in this space isn't the fastest agent — it's the one whose actions are **provable**. That provability is the product.
