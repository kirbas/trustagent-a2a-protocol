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

## Part 5 — Dispute pack sanity check

```bash
curl -s "http://localhost:3002/dispute/<id — see /dispute/:id route in Bank-B/proxy/src/server.ts>" | python3 -m json.tool
```
Confirm it returns a coherent bundle (envelopes + Merkle proof) for the transaction you drove, and that `args`/`output` fields are hashes only, not raw plaintext (that's expected/by-design for this stage — Delta #5 is what would change it, not in scope here).

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
7. **Overall verdict** — PASS/FAIL per section, and an explicit note that this run validates Delta #1 (key custody) plus the pre-existing anchor pipeline; it does **not** exercise Deltas #2–7 (hash-chain, inline co-signer, checkpoint/heartbeat, WORM content store, key-transparency, degraded-mode) since those aren't implemented yet — say so plainly rather than implying broader coverage than what ran.
8. Any CRITICAL findings called out at the very top, before the section-by-section detail.
