# TrustAgentAI — Procurement Handshake Demo

A Dockerized, multi-node demonstration of the A2A Accountability Protocol. Two autonomous bank nodes perform a cryptographically accountable procurement handshake, with a real-time React visualizer and SQLite-backed tamper-evident ledger.

---

## Quick Start

```bash
git clone <repo>
cd Trust-Agent

docker compose up --build
```

> **Blockchain anchoring** requires `RPC_URL` and `PRIVATE_KEY` in a root `.env` file (see `.env.example`). Without them anchoring is silently skipped — the demo still runs fully.

Open **http://localhost:3000** and press **▶ Start Demo**.

Docker builds from scratch take ~4 minutes (compiling native `better-sqlite3`). Subsequent builds are cached.

---

## What the Demo Shows

### Scenario 1 — Successful $5k Procurement
1. `bank-a-agent` (Purchaser) requests a Security Report from `bank-b-node` for $5,000
2. `bank-a-proxy` builds a signed `IntentEnvelope` and POSTs it to `bank-b-proxy`
3. `bank-b-proxy` validates: TTL → nonce uniqueness → Ed25519 signature → risk budget ($10k daily limit allows it)
4. `bank-b-proxy` returns a signed `AcceptanceReceipt` (decision: `ACCEPTED`)
5. `bank-a-proxy` executes the tool (stub returning a mock PDF), builds `ExecutionEnvelope`
6. Both proxies persist all three signed artifacts to their SQLite `envelopes` table
7. `bank-a-proxy` generates a `ContentProvenanceReceipt` (v0.5) binding the output to the trace
8. All thought logs and handshake steps stream live to the frontend
9. `bank-b-proxy` computes a SHA-256 Merkle root over the last batch of envelope signatures and broadcasts it to Base Sepolia as a 0-ETH self-transaction (`runAnchor`)
10. HandshakeVisualizer shows "ANCHORING ⏳" → "ANCHORED ⛓ block N ↗" (BaseScan link); trace border turns amber (orange)
11. Bilateral confirmation: "EXECUTED (A) ✓" and "EXECUTED (B) ✓" visible to confirm both ledgers are in sync.

### Scenario 2 — Blocked $50k Breach
1. `bank-a-agent` autonomously attempts a $50,000 wire transfer
2. `bank-b-proxy` rejects at step 4 (`ERR_BUDGET_EXCEEDED`) — cost exceeds `maxSingleActionUsd: $10,000`
3. The intent is recorded in the DAG ledger; a signed `AcceptanceReceipt` with `decision: "REJECTED"` is appended and written to `bank-b`'s SQLite
4. The frontend HandshakeVisualizer shows the red `REJECTED` badge
5. Non-repudiation is preserved: the rejection is cryptographically signed by Bank-B proxy; the Dispute Pack for this trace is populated (INTENT_RECORD + ACCEPTANCE_RECORD)
6. `bank-b-proxy` also fires `runAnchor` for the rejected trace — the denial is immutably timestamped on-chain alongside successful transactions

---

## Ports

| Service | Host Port | Purpose |
|---|---|---|
| `frontend` | **3000** | React visualizer (nginx) |
| `bank-a-proxy` | **3001** | Proxy A HTTP API |
| `bank-b-proxy` | **3002** | Proxy B HTTP API |
| `bank-b-anchor` | **5001** | Bank-B L2 Notary Service |

---

## Frontend Panels

### Agent Thought Stream (left)
Live interleaved thought logs from both agents, color-coded by node (green = Bank-A, orange = Bank-B). Auto-scrolls to bottom.

### Bilateral Handshake (centre)
Step timeline per `trace_id`. Each trace shows its steps as badges:
- `INTENT → PROXY-B` → `ACCEPTED ✓` → `EXECUTED (A) ✓` → `EXECUTED (B) ✓` → `PROVENANCE ✓` (green, success)
- `INTENT → PROXY-B` → `REJECTED — reason` (red, denied)
All trace IDs are displayed as clean UUIDs (no `urn:uuid:` prefix). Panels are perfectly aligned with standardized 84px headers.

Click **▶ Start Demo** to trigger `bank-a-agent`. Once both scenarios have completed, the button changes to **↺ Clear messages and restart demo** — clicking it resets both proxies and all frontend state so the demo can run again.

### Dispute Console (right)
Two sub-tabs:

**Envelopes tab** — polls `/envelopes` every 3 s on both proxies. Click any row to expand its raw JSON payload. `DENIED` entries are highlighted red.

**Dispute Pack tab** — select a `trace_id`, then:
- **Load** — fetches `GET bank-b-proxy:3002/dispute/<traceId>` and renders the full dispute pack JSON (records, entries, Merkle `inclusionProofs`)
- **Flush + Load** — first calls `POST /flush` to force a Merkle batch commit, then loads the pack (needed for proofs when < 8 entries exist)

**Anchor to L2 tab** — trigger Merkle notarization:
- Click **Anchor to L2** to force Bank-B to anchor all pending receipts to the blockchain.

**Verify Anchor tab** — blockchain proof verification:
- Paste any Base Sepolia tx hash → **Verify** calls `GET bank-b-proxy:3002/verify/<txHash>`
- Green banner: anchor found, all Merkle inclusion proofs valid
- Red banner: tx hash not in local database (or proof failure)
- Leaf table shows each envelope in the batch with its proof validity (✓ / ✗)
- Full dispute pack JSON displayed inline; **↓ JSON** button downloads `{txHash}.json`

**Cross-Check tab** — bilateral integrity verification:
- Select a `trace_id` → **Cross-Check** calls `POST bank-a-proxy:3001/cross-check` to ensure Bank-A and Bank-B possess identical execution envelopes.

---

## Verifying the Demo

```bash
# Check key exchange succeeded
docker logs bank-a-proxy | grep "registered with Proxy B"

# Check acceptance/rejection in Bank-B
docker logs bank-b-proxy | grep -E "ACCEPTED|REJECTED"

# Query SQLite directly
docker exec bank-b-proxy sqlite3 /data/bank-b.db "SELECT type, trace_id, created_at FROM envelopes;"

# Hit the dispute pack API manually
curl -s http://localhost:3002/dispute/<traceId> | python3 -m json.tool

# Force flush then re-query
curl -X POST http://localhost:3002/flush
curl -s http://localhost:3002/dispute/<traceId> | python3 -m json.tool

# Check blockchain anchor status in Bank-A
docker exec bank-a-proxy sqlite3 /data/bank-a.db "SELECT batch_id, status, block_number FROM anchors;"

# Verify a dispute pack by tx hash
curl -s http://localhost:3001/verify/0x<txHash> | python3 -m json.tool
```

---

## Re-running Scenarios

Click **↺ Clear messages and restart demo** in the Bilateral Handshake panel — it resets both proxies (in-memory state + SQLite) and clears all frontend panels without restarting containers. The agent automatically waits for the next trigger.

To reset all state including keys and volumes:
```bash
docker compose down -v   # removes named volumes
docker compose up --build
```

---

## Project Structure

```
Trust-Agent/
├── trust-agent/          Core @trustagentai/a2a-core library (DO NOT MODIFY)
├── Bank-A/
│   ├── proxy/            TypeScript/Express Proxy A
│   ├── agent/            Python autonomous purchaser agent
│   └── merkle-anchor/    Python DDD service: standalone Merkle anchor CLI
├── Bank-B/
│   ├── proxy/            TypeScript/Express Proxy B
│   └── agent/            Python reactive vendor agent
├── frontend/             React/Vite visualizer (served by nginx)
├── docs/                 This documentation
└── docker-compose.yml    5-service orchestration
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed technical design.
See [AGENT_CONTEXT.md](AGENT_CONTEXT.md) for AI agent continuation context.
