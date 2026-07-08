# E2E Test Prompt — Gemini 3.5 (Antigravity)

**Purpose:** hand this whole file to Gemini 3.5 in Antigravity as its task prompt. It drives a full local `docker-compose` stack, forces one real transaction all the way to a Base Sepolia on-chain anchor, and verifies every hop: proxy identity durability, DB persistence, signature validity, Merkle proof, and the on-chain tx itself.

**Repo:** `/home/ikarin/Trust-Agent` · **Branch to test:** `feat/delta-1-durable-keys` (contains Delta #1 — durable, custodied proxy keys — from `docs/execution_plan.md`; not yet merged to `main`).

Copy everything below the `---` into Antigravity as-is.

---

## Role

You are a QA/verification agent. Your job is to **run, observe, and report** — not to fix bugs or refactor code. If something fails, capture the exact evidence (logs, curl output, sqlite rows) and report it; do not silently patch it and re-run unless the task explicitly says so. Do not `git push`, `git merge`, or touch `main`. Do not modify `.env`.

## Context you need

- This is `TrustAgentAI` — a cryptographic accountability layer for AI-agent-to-agent payments (`docs/execution_plan.md`, `docs/DISPUTE_HARDENING.md` have the full design; skim them before starting, do not re-litigate the decisions in them).
- Three-phase protocol per transaction: **IntentEnvelope** (Proxy A signs) → **AcceptanceReceipt** (Proxy B signs) → **ExecutionEnvelope** (Proxy B signs after execution). All three share a `trace_id`.
- Bank-B batches executed envelopes and anchors the Merkle root of the batch to **Base Sepolia** (chain id 84532) as a 0-ETH self-transaction with the root in `data`. This anchoring path already exists and is *not* part of Delta #1 — you are exercising it end-to-end, not testing new anchor code.
- **Delta #1 (what's new on this branch):** proxies used to mint a fresh Ed25519 key every boot. Now each proxy loads a persistent identity from an **encrypted keystore file** (AES-256-GCM), with the decryption key (`KEYSTORE_KEK`) coming from an env var separate from the database. Your job includes proving this actually survives a restart and fails loudly on a bad key — that's the acceptance criteria for this delta.

## Pre-flight (do this first, stop and report if any of these fail)

1. `cd /home/ikarin/Trust-Agent && git status` — confirm branch is `feat/delta-1-durable-keys` and the tree is clean. If not on that branch, `git checkout feat/delta-1-durable-keys` (do not create commits).
2. Confirm `.env` exists and has **all** of: `RPC_URL`, `PRIVATE_KEY`, `BANK_A_KEYSTORE_KEK`, `BANK_B_KEYSTORE_KEK` (all already present as of this writing — just verify, don't print the values). `ANTHROPIC_API_KEY` is **not required**: agents default to local Ollama (`AGENT_MODEL_ID=ollama/qwen3.5:9b` for Bank-A, `ollama/qwen3.6:27b` for Bank-B).
3. Confirm local Ollama is reachable and has both default models pulled:
   ```bash
   curl -s http://localhost:11434/api/tags | grep -o '"name":"[^"]*"'
   ```
   Must show `qwen3.5:9b` and `qwen3.6:27b` (or override `AGENT_MODEL_ID`/`OLLAMA_BASE_URL` in your shell env before compose-up if you use different tags — do not edit `.env`).
4. Confirm the Base Sepolia burner wallet (`PRIVATE_KEY`) has gas. You don't have the address directly — derive and check it from inside the anchor container after step "Startup" below (command given there). If balance is 0, **do not attempt to fund it yourself** — report it and stop before the anchoring step; everything else in this test can still run.
5. Confirm ports 3000–3002, 4001–4002, 5001 are free on the host.

## Startup

```bash
cd /home/ikarin/Trust-Agent
docker compose up --build -d
docker compose ps
```

Wait for all services to report healthy (`bank-a-proxy`, `bank-b-proxy` have healthchecks; poll `docker compose ps` or `docker inspect --format '{{.State.Health.Status}}' bank-a-proxy bank-b-proxy` until both are `healthy`, timeout ~90s).

Check every node is actually up:
```bash
curl -sf http://localhost:3001/health   # bank-a-proxy
curl -sf http://localhost:3002/health   # bank-b-proxy
curl -sf http://localhost:4001/health   # bank-a-agent
curl -sf http://localhost:4002/health   # bank-b-agent
curl -sf http://localhost:5001/health   # bank-b-anchor (merkle notary)
curl -sf http://localhost:3003/health   # trust-agent-cloud (inline co-sign witness, Delta #3)
curl -sf http://localhost:3000/         # frontend
```
All must return success. Report any that don't, with `docker compose logs <service> --tail 50`.

Derive the anchor wallet address and check its Base Sepolia balance (uses the anchor container's already-installed `web3`/`eth_account`):
```bash
docker compose exec bank-b-anchor python3 -c "
from eth_account import Account
import os
addr = Account.from_key(os.environ['PRIVATE_KEY']).address
print(addr)
"
# then, with $RPC_URL from your shell / .env:
curl -s -X POST "$RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["<ADDR_FROM_ABOVE>","latest"]}'
```
If the hex balance is `0x0`, note it clearly in the final report — the on-chain anchor step will fail with no gas, and that's an environment issue, not a code bug. (Base Sepolia faucet: report the address to the user; do not attempt to acquire funds yourself.)

## Part 1 — Prove key durability (Delta #1 acceptance criteria)

1. Capture each proxy's current public key. The cleanest source is the `register-peer-key` call Bank-A makes to Bank-B at boot — grep the startup logs:
   ```bash
   docker compose logs bank-a-proxy | grep -i "key-exchange\|register"
   docker compose logs bank-b-proxy | grep -i "register-peer-key"
   ```
   Also confirm the keystore files exist on the volumes and are **not plaintext**:
   ```bash
   docker compose exec bank-a-proxy cat /data/bank-a-keystore.json
   docker compose exec bank-b-proxy cat /data/bank-b-keystore.json
   ```
   Each must be JSON `{ kid, publicKey, iv, ciphertext, tag }` — record the `publicKey` hex value from each. `ciphertext` must **not** decode to anything resembling a raw 32-byte key pattern you can eyeball as plausible plaintext (it's encrypted, this is just a sanity look).

2. Restart both proxies (not a full stack rebuild — this must reuse the same volumes, so it exercises the *load* path, not first-boot *create*):
   ```bash
   docker compose restart bank-a-proxy bank-b-proxy
   ```
   Wait for both to be `healthy` again, then re-extract the `publicKey` from each keystore file the same way as step 1.

   **PASS criterion:** both `publicKey` values are byte-for-byte identical before and after restart. **FAIL** = any code that regenerates a key on restart is broken — flag as CRITICAL, do not proceed to blame Part 2/3 results on it, since a rotating identity would make every downstream signature check meaningless.

3. Confirm private key material never appears in logs or the DB, anywhere:
   ```bash
   docker compose logs bank-a-proxy bank-b-proxy | grep -iE "privateKey|private_key"
   docker compose exec bank-a-proxy sh -c "strings /data/bank-a.db | grep -i privatekey" || true
   docker compose exec bank-b-proxy sh -c "strings /data/bank-b.db | grep -i privatekey" || true
   ```
   All three must return nothing. If anything matches, capture the exact line as CRITICAL.

4. (Optional but valuable — isolated, does not affect the running stack) Re-run the automated proof of wrong-KEK / malformed-KEK / tampered-ciphertext behavior that's already unit-tested on this branch, to confirm it still holds on this checkout:
   ```bash
   cd /home/ikarin/Trust-Agent/trust-agent && npm test && npm run test:coverage
   ```
   Record the pass count and coverage numbers in your report.

## Part 2 — Drive one real transaction end-to-end

1. Open SSE streams so you can watch events live (run in background / separate terminal, or poll `GET /events` with `curl -N` for a bounded time window):
   ```bash
   curl -N http://localhost:3001/events &
   curl -N http://localhost:3002/events &
   ```

2. Fire the demo trigger (this makes `bank-a-agent` run its autonomous scenario loop, which calls tools through Proxy A → Proxy B):
   ```bash
   curl -sf -X POST http://localhost:3001/trigger
   ```

3. Watch `docker compose logs -f bank-a-agent bank-b-agent bank-a-proxy bank-b-proxy` for ~30–60s. You're looking for at least one full Intent → Accept → Execute cycle. Capture a `trace_id` from the logs or from:
   ```bash
   curl -s http://localhost:3001/envelopes | python3 -m json.tool | head -60
   ```

4. Confirm the agent loop finished:
   ```bash
   curl -s http://localhost:3001/trigger-status   # expect {"triggered": false} once done
   ```

## Part 3 — Verify DB persistence

**Known API asymmetry (not a Delta #1 regression, don't re-report it):** Bank-B exposes `GET /envelopes-by-trace/:traceId`; Bank-A does not — it only has `GET /envelopes` (all rows) and uses `getEnvelopesByTraceId` internally inside `/cross-check`, with no route exposing it directly. Use the per-bank commands below as-is.

Bank-A (filter the full list client-side — there is no per-trace route):
```bash
curl -s "http://localhost:3001/envelopes" | python3 -c "
import json,sys
rows = [e for e in json.load(sys.stdin) if e.get('trace_id') == '<TRACE_ID>']
print(json.dumps(rows, indent=2))
"
```
Bank-B (per-trace route exists):
```bash
curl -s "http://localhost:3002/envelopes-by-trace/<TRACE_ID>" | python3 -m json.tool
```
Then confirm the same rows exist directly in SQLite (not just via the API — this is the point of the check). The `envelopes` table schema is `(id TEXT PRIMARY KEY, type TEXT, trace_id TEXT, raw_payload TEXT, signature TEXT, created_at TEXT)`:
```bash
docker compose exec bank-a-proxy sh -c "apk add --no-cache sqlite 2>/dev/null; sqlite3 /data/bank-a.db \"SELECT id, type, trace_id, created_at FROM envelopes WHERE trace_id='<TRACE_ID>';\""
docker compose exec bank-b-proxy sh -c "apk add --no-cache sqlite 2>/dev/null; sqlite3 /data/bank-b.db \"SELECT id, type, trace_id, created_at FROM envelopes WHERE trace_id='<TRACE_ID>';\""
```
(If `sqlite3` CLI isn't available and `apk add` fails because the base image isn't Alpine, instead copy the DB out and inspect on the host: `docker cp bank-b-proxy:/data/bank-b.db ./bank-b.db.tmp && sqlite3 ./bank-b.db.tmp "..."`.)

**PASS criterion:** rows exist on both sides for the same `trace_id`, `raw_payload` is present and non-empty, and re-verifying each envelope's signature succeeds:
```bash
curl -s "http://localhost:3002/verify-trace/<TRACE_ID>" | python3 -m json.tool
```

## Part 3b — Hash-chain continuity (Delta #2)

Each proxy links its envelope rows into an append-only hash-chain (`seq` + `prev_hash`). Verify it holds, then prove tampering/deletion is detectable.

1. Both chains verify clean after the transaction:
   ```bash
   curl -s http://localhost:3001/verify-chain | python3 -m json.tool   # expect {"valid": true}
   curl -s http://localhost:3002/verify-chain | python3 -m json.tool   # expect {"valid": true}
   ```
2. Inspect the new columns directly (should be a gapless 0,1,2,… sequence with non-null `prev_hash`):
   ```bash
   docker compose exec bank-b-proxy sh -c "sqlite3 /data/bank-b.db 'SELECT seq, substr(prev_hash,1,12), type FROM envelopes ORDER BY seq;'" 2>/dev/null \
     || (docker cp bank-b-proxy:/data/bank-b.db ./bank-b.db.tmp && sqlite3 ./bank-b.db.tmp "SELECT seq, substr(prev_hash,1,12), type FROM envelopes ORDER BY seq;")
   ```
3. **Tamper-detection (do this on the copied `./bank-b.db.tmp`, NOT the live container DB — do not corrupt the running stack):** edit one row's `raw_payload` in the copy, then run the same verify logic against it, or reason from `/verify-chain` semantics. Expected: mutating any row's content breaks its successor's `prev_hash` link; deleting a row opens a `seq` gap — either makes `verifyChain` return `{"valid": false, "error": ...}`. Report whether the break is detected. (You can confirm this deterministically via the unit tests instead: `cd trust-agent && npm test -- hash-chain` — the tamper and gap cases are covered there.)

## Part 3c — Witness inline co-sign & finality gate (Delta #3)

An independent service, **`trust-agent-cloud`** (port 3003), co-signs each transaction *inline between Phase 2 (Acceptance) and Phase 3 (Execution)*. It is independent of both banks: its own durable Ed25519 key (own `TRUSTAGENT_KEYSTORE_KEK`, separate from the banks' KEKs and from any DB), and its own append-only hash-chain. A transaction that cannot obtain a valid witness co-signature is **not** finalized.

1. Confirm the transaction you drove in Part 2 carries a witness co-signature. Bank-A persists it as a `COSIGN` envelope row alongside INTENT/ACCEPTANCE/EXECUTION:
   ```bash
   curl -s "http://localhost:3001/envelopes" | python3 -c "
   import json,sys
   rows=[e for e in json.load(sys.stdin) if e.get('trace_id')=='<TRACE_ID>']
   print(sorted({e['type'] for e in rows}))
   "
   ```
   **PASS criterion:** the set includes `COSIGN` (in addition to `INTENT`, `ACCEPTANCE`, `EXECUTION`). The `COSIGN` row's `raw_payload` is a `CoSignReceipt` whose single signature has `role: "witness"` and `kid: did:workload:trustagent-cloud#key-1`, and whose `intent_hash`/`acceptance_hash` bind this trace's envelopes.

2. The witness's own hash-chain verifies clean, and has exactly one link per co-signed transaction:
   ```bash
   curl -s http://localhost:3003/verify-chain | python3 -m json.tool   # expect {"valid": true}
   docker compose exec trust-agent-cloud sh -c "sqlite3 /data/trust-agent-cloud.db 'SELECT seq, substr(prev_hash,1,12), type, trace_id FROM cosigns ORDER BY seq;'" 2>/dev/null \
     || (docker cp trust-agent-cloud:/data/trust-agent-cloud.db ./tac.db.tmp && sqlite3 ./tac.db.tmp "SELECT seq, substr(prev_hash,1,12), type, trace_id FROM cosigns ORDER BY seq;")
   ```
   Expect a gapless `seq` (0,1,2,…), non-null `prev_hash`, `type=COSIGN`, one row per `trace_id`.

3. Witness key durability (same guarantee as Delta #1, for the witness): the keystore is encrypted at rest and the public key survives a restart.
   ```bash
   docker compose exec trust-agent-cloud cat /data/trust-agent-cloud-keystore.json   # JSON {kid, publicKey, iv, ciphertext, tag}
   docker compose restart trust-agent-cloud                                          # wait until healthy
   curl -s http://localhost:3003/health                                             # witness_kid unchanged
   docker compose exec trust-agent-cloud sh -c "strings /data/trust-agent-cloud.db | grep -i privatekey" || true   # must be empty
   ```
   **PASS criterion:** keystore is JSON with an encrypted `ciphertext` (no plaintext key), `witness_kid` is identical after restart, and no private-key material appears in the DB.

4. Finality gate (proves the witness is load-bearing, not decorative). With the stack up, take the witness offline, drive a fresh transaction, and confirm it does **not** finalize:
   ```bash
   docker compose stop trust-agent-cloud
   curl -sf -X POST http://localhost:3001/trigger    # or POST /invoke; watch bank-a-proxy logs
   ```
   **PASS criterion:** the new transaction is rejected/never completes (Proxy A returns a witness error, code `-32006`, and does **not** produce an EXECUTION for that new trace) — a transaction without a valid co-signature is not valid. Restart the witness afterwards (`docker compose start trust-agent-cloud`, wait healthy). *(Optional deterministic equivalent: `cd trust-agent && npm test -- trust-proxy` covers the gate; `cd trust-agent-cloud && npm test` covers witness verification, chaining, and idempotency.)*

## Part 3d — WORM content store & envelope-encryption (Delta #5)

`args`/`outputData` are no longer discarded — Bank-A persists them as encrypted, content-addressed WORM blobs (per-tx DEK, AES-256-GCM), envelope-encrypted for each holder (`bank-a`, `client`, `witness`) plus a separate regulator escrow entry. Requires `BANK_A_CONTENT_KEK`, `CLIENT_CONTENT_KEK`, `TRUSTAGENT_CONTENT_KEK`, `REGULATOR_ESCROW_KEK` in `.env` — WORM storage silently no-ops (existing flow keeps working) if any is missing.

1. Confirm WORM is active (no "disabled" warning):
   ```bash
   docker compose logs bank-a-proxy | grep -i worm
   ```
   If it shows "content-KEK env vars not fully configured", set the 4 vars above in `.env`, `docker compose up -d --build bank-a-proxy`, and re-drive Part 2 before continuing.

2. **DoD #1 — content address equals the envelope's committed hash.** Pull the trace's `args_hash`/`output_hash` and Bank-A's local blob table:
   ```bash
   curl -s "http://localhost:3001/envelopes" | python3 -c "
   import json,sys
   rows=[e for e in json.load(sys.stdin) if e.get('trace_id')=='<TRACE_ID>']
   for r in rows:
       if r['type'] in ('INTENT','EXECUTION'):
           p=json.loads(r['raw_payload'])
           print(r['type'], p.get('payload',{}).get('args_hash') or p.get('result',{}).get('output_hash'))
   "
   docker compose exec bank-a-proxy sh -c "sqlite3 /data/bank-a.db 'SELECT content_hash FROM content_blobs;'" 2>/dev/null \
     || (docker cp bank-a-proxy:/data/bank-a.db ./bank-a.db.tmp && sqlite3 ./bank-a.db.tmp "SELECT content_hash FROM content_blobs;")
   ```
   **PASS criterion:** the `content_hash` values include the `args_hash`/`output_hash` printed above — the WORM blob id is exactly `sha256(plaintext)`, the same commitment already in the envelope.

3. Confirm only ciphertext is stored — never plaintext or a bare key:
   ```bash
   docker compose exec bank-a-proxy sh -c "sqlite3 /data/bank-a.db 'SELECT ciphertext, wrapped_deks FROM content_blobs LIMIT 1;'" 2>/dev/null \
     || sqlite3 ./bank-a.db.tmp "SELECT ciphertext, wrapped_deks FROM content_blobs LIMIT 1;"
   ```
   `ciphertext` must be opaque hex (not recognizable plaintext/JSON); `wrapped_deks` must be a JSON object of `{iv, ciphertext, tag}` entries per holder — never a raw key.

4. **Cross-hold.** The same encrypted record must also be retrievable from the witness:
   ```bash
   curl -s "http://localhost:3003/blob/<CONTENT_HASH>" | python3 -m json.tool
   ```
   **PASS criterion:** 200, with `ciphertext`/`iv`/`tag` identical to Bank-A's local row — content is cross-held on ≥2 independent stores (Bank-A + TrustAgentAI), not just locally.

5. **Write-once (WORM) rejection.** Re-`PUT` the same content hash with different ciphertext:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X PUT "http://localhost:3003/blob/<CONTENT_HASH>" \
     -H 'content-type: application/json' -d '{"ciphertext":"00","iv":"00","tag":"00","wrappedDeks":{}}'
   ```
   **PASS criterion:** non-2xx (409) — a second write under the same content hash with different bytes is refused. Re-`PUT`-ting the exact same body from step 4 must instead return 200 with `created:false` (idempotent).

6. **Escrow (Decision #11 / DISPUTE §5.4).** No running key material exists to hand a QA agent for this — that is the point of the design. Exercise it via the unit tests instead:
   ```bash
   cd /home/ikarin/Trust-Agent/trust-agent && npx vitest run src/worm-store.test.ts
   ```
   **PASS criterion:** all pass, including `"lets the regulator unwrap the escrow entry but not the witness"`.

7. Confirm the witness's own environment never has the escrow key:
   ```bash
   docker compose exec trust-agent-cloud sh -c 'env | grep -i escrow' || true
   ```
   **PASS criterion:** empty output — escrow is not held by TrustAgentAI.

8. `verifyChain` is unaffected (WORM storage is additive, not a chain change):
   ```bash
   curl -s http://localhost:3001/verify-chain | python3 -m json.tool   # still {"valid": true}
   curl -s http://localhost:3003/verify-chain | python3 -m json.tool   # still {"valid": true}
   ```

## Part 3e — Key-transparency registry (Delta #6)

`register-peer-key` (Bank-B) and `register-key` (witness) are no longer "last write wins": both are now backed by an append-only `KeyRegistry`. A DID's first registration is trust-on-first-use; any later one is a **rotation** and must be **endorsed** — signed by the DID's prior key. Revocation closes a key's validity window without deleting its history.

1. **Bootstrap is unaffected (regression check).** The stack already registered both proxies' boot-time keys with each other and the witness in Startup — confirm those first-registrations still show up:
   ```bash
   curl -s http://localhost:3002/key-history/did:workload:bank-a-proxy#key-1 | python3 -m json.tool
   curl -s http://localhost:3003/key-history/did:workload:bank-a-proxy#key-1 | python3 -m json.tool
   ```
   **PASS criterion:** one epoch each, `validUntil: null` (still active).

2. **Endorsed rotation, live.** Generate a second Ed25519 keypair for Bank-A's DID and an endorsement signed by its *current* key — easiest via a short Node one-liner using the already-built package:
   ```bash
   docker compose exec bank-a-proxy node -e "
   const { generateKeyPair, buildRotationAttestation, signRotation, loadOrCreateKeyPair } = require('@trustagentai/a2a-core');
   (async () => {
     const oldKey = await loadOrCreateKeyPair('did:workload:bank-a-proxy#key-1', '/data/bank-a-keystore.json', process.env.KEYSTORE_KEK);
     const newKey = await generateKeyPair('did:workload:bank-a-proxy#key-2');
     const newPubHex = Buffer.from(newKey.publicKey).toString('hex');
     const ts = new Date().toISOString();
     const attestation = buildRotationAttestation('did:workload:bank-a-proxy', newKey.kid, newPubHex, ts);
     const endorsement = await signRotation(attestation, oldKey);
     console.log(JSON.stringify({ kid: newKey.kid, publicKeyHex: newPubHex, timestamp: ts, endorsement }));
   })();
   "
   ```
   POST the printed JSON to both registries:
   ```bash
   curl -s -X POST http://localhost:3002/register-peer-key -H 'content-type: application/json' -d '<PRINTED_JSON>'
   curl -s -X POST http://localhost:3003/register-key -H 'content-type: application/json' -d '<PRINTED_JSON>'
   ```
   **PASS criterion:** both `{"ok":true}`. Then:
   ```bash
   curl -s http://localhost:3002/key-history/did:workload:bank-a-proxy#key-1 | python3 -m json.tool
   ```
   The `#key-1` epoch now has a non-null `validUntil`; a `GET .../key-history/did:workload:bank-a-proxy#key-2` shows the new epoch with `validUntil: null`. History is additive — nothing was deleted or overwritten.

3. **Unendorsed / badly-endorsed rotation is rejected.** Repeat step 2's POST but omit `endorsement`, or reuse a stale/mismatched one:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3002/register-peer-key \
     -H 'content-type: application/json' -d '{"kid":"did:workload:bank-a-proxy#key-3","publicKeyHex":"00"}'
   ```
   **PASS criterion:** `400` — a DID with an existing key cannot be silently overwritten. (Deterministic equivalent, no live stack needed: `cd trust-agent && npx vitest run src/key-registry.test.ts` — covers unendorsed, wrong-key-endorsed, and duplicate-kid-different-key rejection explicitly.)

4. **Revocation-as-append.** Build `{did, revoke_kid, timestamp}` signed by the *currently active* key (same pattern as step 2, target `/revoke-peer-key` or `/revoke-key` with `{kid, endorsement, timestamp}`), then re-check `/key-history/:kid` — the active epoch's `validUntil` is now set, but the row is still present (not deleted), and the revoked key's own past signatures remain independently verifiable (only *new* registrations for that DID are now blocked without it).

**Note:** rotating Bank-A's live signing key mid-run means subsequent `/invoke` calls sign with the *old* key unless the proxy process itself is restarted with a new keystore — this section proves the **registry's** append-only/endorsement mechanics, not an operational "rotate now" flow (that wiring is intentionally out of scope for this delta; see the PR's residual-risk note).
## Part 3f — Degraded-mode discipline (Delta #7)

Today the witness is a hard finality gate: if `/co-sign` fails, the transaction is rejected outright (`ERR_WITNESS_UNAVAILABLE`). Delta #7 adds a bounded fallback: when `DEGRADED_MODE_ENABLED=true`, a witness failure may instead produce a **capped, tracked** degraded record instead of hard-failing — never a forged witness signature.

1. **Default (disabled) behavior is unchanged — regression check.** With `DEGRADED_MODE_ENABLED` unset/`false` (the default), repeat Part 3c step 4 (stop the witness, drive a transaction): it must still hard-fail exactly as before. Restart the witness afterward.

2. **Enable degraded mode and force a witness outage:**
   ```bash
   docker compose stop trust-agent-cloud
   curl -s -X POST http://localhost:3001/invoke -H 'content-type: application/json' \
     -d '{"tool":"security_posture_report","args":{"probe":"delta7"},"cost":50}' | python3 -m json.tool
   ```
   (Requires `DEGRADED_MODE_ENABLED=true` and `DEGRADED_MAX_VALUE_USD` ≥ 50 in `.env`, stack rebuilt — `docker compose up -d --build bank-a-proxy`.)
   **PASS criterion:** the response is a normal `result` (not an `error`), `_a2a.cosign_receipt` is absent, and `_a2a.degraded_record` is present with `reason` mentioning "unreachable" and a `reconcile_by` timestamp in the future.

3. **Value cap rejection.** Repeat step 2 with `"cost"` above `DEGRADED_MAX_VALUE_USD` — expect a normal MCP `error` response (hard-fail), same as the fully-disabled case: the cap, not the mere presence of `degradedMode`, is what's load-bearing.

4. **Persisted + queryable.** Restart the witness, then:
   ```bash
   curl -s "http://localhost:3001/degraded-status/<TRACE_ID_FROM_STEP_2>" | python3 -m json.tool
   ```
   **PASS criterion:** `status: "PENDING"` (if within the reconciliation window) with the same `reconcile_by`/`reason` as the original response — the DEGRADED row survived as its own envelope-chain entry, not just transient response JSON.

5. **Reconciliation.** With the witness back up:
   ```bash
   curl -s -X POST "http://localhost:3001/reconcile/<TRACE_ID_FROM_STEP_2>" | python3 -m json.tool
   curl -s "http://localhost:3001/degraded-status/<TRACE_ID_FROM_STEP_2>" | python3 -m json.tool
   ```
   **PASS criterion:** the reconcile call returns a real `cosign_receipt`; the status call now reads `"RECONCILED"` — a `COSIGN` row now exists for that trace (check `GET /envelopes`), turning a degraded record into a fully-witnessed one after the fact.

6. **Expiry (deterministic, no live wait needed):** `cd trust-agent && npx vitest run src/degraded-mode.test.ts` covers `reconciliationStatus` returning `EXPIRED_UNRECONCILED` once `reconcile_by` passes with no co-sign — the auto-flag-invalid half of the reconciliation window, without waiting out a real deadline live.

**Note:** the rate cap (`DEGRADED_MAX_PER_WINDOW`) and the value cap are exercised together in `trust-proxy.test.ts`/`degraded-mode.test.ts`; reproducing the rate cap live would mean forcing `DEGRADED_MAX_PER_WINDOW + 1` witness outages in one `DEGRADED_WINDOW_SECONDS` window, which isn't worth the wall-clock cost here — the deterministic test is the evidence for that path.

## Part 4 — Force the on-chain anchor and verify it for real

1. Trigger an immediate anchor of whatever's pending (don't wait for the auto-batch threshold):
   ```bash
   curl -sf -X POST http://localhost:3002/anchor-now
   ```
2. Poll until it's confirmed:
   ```bash
   curl -s http://localhost:3002/anchors | python3 -m json.tool
   ```
   Look for an entry with `status` no longer `PENDING`, and a populated `tx_hash` + `block_number`.
3. Verify the transaction actually landed on Base Sepolia, independent of this app's own DB:
   ```bash
   curl -s -X POST "$RPC_URL" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["<TX_HASH>"]}' | python3 -m json.tool
   ```
   `status` must be `"0x1"`. Also note the link `https://sepolia.basescan.org/tx/<TX_HASH>` in your report (no need to screenshot it — the RPC receipt is sufficient evidence).
4. Verify the Merkle proof for the transaction you drove in Part 2 reconciles against that anchored root:
   ```bash
   curl -s "http://localhost:3002/verify/<TX_HASH>" | python3 -m json.tool
   ```
   Confirm the response indicates the proof is valid for your `trace_id`'s leaf.

## Part 4b — Chain HEAD checkpoint & heartbeat (Delta #4)

The anchor now also anchors each party's **chain HEAD checkpoint** (`{party, head_seq, head_prev_hash, row_count}` → 32-byte commitment) and can publish a **monotonic on-chain heartbeat**. Per the design these close *"when"* (public ordering/time), not tampering — so the commitment binds only chain-position fields.

1. Anchor the Bank-B chain HEAD checkpoint (after Part 2 drove at least one transaction, so the chain is non-empty):
   ```bash
   curl -sf -X POST http://localhost:5001/checkpoint | python3 -m json.tool
   ```
   Expect `status: "success"`, a `headSeq`/`rowCount` matching Bank-B's `/verify-chain` head, a `commitment`, and a real `txHash`/`blockNumber`. Verify the tx on Base Sepolia independently:
   ```bash
   curl -s -X POST "$RPC_URL" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["<TX_HASH>"]}' | python3 -m json.tool
   ```
   `status` must be `"0x1"`, and the tx `input`/`data` must equal `0x<commitment>`.

2. Idempotence: re-POST `/checkpoint` with **no new envelopes** → `status: "noop"` (`head unchanged`), no new on-chain tx. Then drive another transaction (Part 2) and re-POST → a **new** checkpoint at a higher `headSeq`.
   ```bash
   curl -s http://localhost:5001/checkpoints | python3 -m json.tool   # gapless, head_seq increasing, status CONFIRMED
   ```

3. Heartbeat — publish two beats and confirm they chain and increment:
   ```bash
   curl -sf -X POST http://localhost:5001/heartbeat | python3 -m json.tool   # seq 0
   curl -sf -X POST http://localhost:5001/heartbeat | python3 -m json.tool   # seq 1
   curl -s http://localhost:5001/heartbeats | python3 -m json.tool
   ```
   **PASS criterion:** `seq` is a gapless 0,1,…; each beat's `prev_hash` equals the previous beat's `commitment` (genesis `0×64` for seq 0); each carries a confirmed `tx_hash`. (The periodic background publisher is opt-in via `HEARTBEAT_ENABLED=true` — it continuously spends gas, so leave it off unless specifically exercising it; the endpoints above are sufficient.)
   *(Optional deterministic equivalent, no gas: `cd Bank-B/merkle-anchor && python3 -m pytest` — checkpoint HEAD/idempotence/gap-refusal and heartbeat chaining/gap-detection are covered against a mocked notary.)*

## Part 5 — Dispute pack sanity check

```bash
curl -s "http://localhost:3002/dispute/<id — see /dispute/:id route in Bank-B/proxy/src/server.ts>" | python3 -m json.tool
```
Confirm it returns a coherent bundle (envelopes + Merkle proof) for the transaction you drove. The pack itself still carries only hashes (`args_hash`/`output_hash`) — recovering the plaintext they commit to is the WORM store's job (Part 3d), fetched separately by a holder, not inlined into this bundle.

## Cleanup

```bash
docker compose down
```
Do **not** remove volumes (`docker compose down -v`) unless explicitly told to — they hold the keystore files whose durability you just proved.

## Report format

Produce a single markdown report with:

1. **Pre-flight** — pass/fail per check in that section, wallet address + balance found.
2. **Key durability (Delta #1)** — public keys before/after restart (must match), keystore file shape, log/DB grep results for leaked private key material, unit test pass count + coverage.
3. **Transaction flow** — the `trace_id` used, timestamps of each phase, envelope IDs.
4. **DB persistence** — row counts/contents from both banks' SQLite, signature re-verification result.
5. **On-chain anchor** — `tx_hash`, `block_number`, RPC receipt status, Merkle proof verification result, Basescan link.
6. **Dispute pack** — confirm retrievable and internally consistent.
7. **Witness co-sign (Delta #3)** — `COSIGN` present for the trace, witness `/verify-chain` valid + gapless `cosigns` rows, witness key durable across restart with no leaked private material, and the finality-gate result (transaction rejected while the witness was down).
8. **Checkpoint & heartbeat (Delta #4)** — HEAD checkpoint anchored (tx on-chain, data = commitment), idempotent no-op on unchanged head, gapless `checkpoints`; heartbeats chain + increment with confirmed txs.
9. **WORM content store (Delta #5)** — content-address == envelope commitment (DoD #1), only ciphertext + wrapped-DEKs ever at rest, cross-held on Bank-A + witness, write-once rejection of a differing PUT under an existing hash (with idempotent accept of the identical one), escrow unit test result, and confirmation the witness's own env never holds the escrow key.
10. **Key-transparency registry (Delta #6)** — bootstrap registrations intact, an endorsed rotation accepted and visible in `/key-history` with the old epoch closed (`validUntil` set) and the new one open, an unendorsed/badly-endorsed rotation rejected (`400`), and revocation-as-append (epoch closed, not deleted).
11. **Degraded-mode discipline (Delta #7)** — disabled-by-default behavior unchanged (regression), an allowed degraded fallback producing a `degraded_record` (no forged witness signature), value-cap rejection, persisted + queryable via `/degraded-status`, and reconciliation turning it into a real `COSIGN` via `/reconcile`.
12. **Overall verdict** — PASS/FAIL per section, and an explicit note that this run validates the full delta backlog: Delta #1 (key custody), Delta #2 (hash-chain), Delta #3 (inline co-sign witness + finality gate), Delta #4 (chain HEAD checkpoint + on-chain heartbeat), Delta #5 (WORM content store + envelope-encryption), Delta #6 (append-only key-transparency registry), Delta #7 (degraded-mode discipline), plus the pre-existing anchor pipeline. Residual (by design, DISPUTE_HARDENING §5.3): "TrustAgentAI + one bank colluding" is **not** closed by any of this — Delta #4 narrows §5.2 (a heartbeat gap makes anchor/witness downtime publicly provable) and Delta #7 narrows it further (an outage no longer force-fails everything, only unbounded-value transactions), but a colluding witness+bank pair remains outside scope. Delta #5's holder-KEK model is a pre-shared symmetric secret (same simplification as every other KEK in this repo) — Bank-A, as plaintext origin, ends up holding the witness's and client's content-KEK values too; no confidentiality loss vs. the pre-Delta-5 baseline. Delta #6 closes "whose key" repudiation for rotations but recovering a DID whose only key is lost/revoked (no prior key to endorse a replacement) is an explicit, out-of-scope bootstrap problem. Delta #7's degraded records are unsigned by design — their tamper-evidence comes from the envelope hash-chain, not an independent signature; a colluding Bank-A could fabricate a plausible-looking outage, bounded only by the value/rate caps.
13. Any CRITICAL findings called out at the very top, before the section-by-section detail.
