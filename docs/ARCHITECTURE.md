# Architecture — Procurement Handshake Demo

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Docker Network (bridge)                                            │
│                                                                     │
│  ┌──────────────┐    POST /invoke     ┌──────────────────────────┐ │
│  │ bank-a-agent │ ──────────────────► │      bank-a-proxy        │ │
│  │   (Python)   │    POST /thought    │   (TypeScript/Express)   │ │
│  │              │ ──────────────────► │   ProxyAGateway wrapper  │ │
│  │  Scenarios:  │                     │   SQLite: bank-a.db      │ │
│  │  · $5k OK    │                     │   SSE broadcast bus      │ │
│  │  · $50k DENY │                     └────────────┬─────────────┘ │
│  └──────────────┘                                  │               │
│                                           POST /accept             │
│                                           POST /executed           │
│                                           POST /register-peer-key  │
│                                                    │               │
│  ┌──────────────┐    SSE /events      ┌────────────▼─────────────┐ │
│  │ bank-b-agent │ ◄──────────────────  │      bank-b-proxy        │ │
│  │   (Python)   │    POST /thought    │   (TypeScript/Express)   │ │
│  │              │ ──────────────────► │   ProxyBGateway wrapper  │ │
│  │  Reacts to:  │                     │   SQLite: bank-b.db      │ │
│  │  · accepted  │                     │   DAGLedger (in-memory)  │ │
│  │  · rejected  │                     │   SSE broadcast bus      │ │
│  └──────────────┘                     └──────────────────────────┘ │
│                                                    ▲               │
│  ┌──────────────────────────────────┐              │               │
│  │           frontend               │  SSE /events (both proxies) │
│  │       (React + nginx)            │  GET /envelopes             │
│  │  http://localhost:3000           │  GET /dispute/:id           │
│  │                                  │  POST /flush                │
│  │  · ThoughtStream                 │◄────────────────────────────│
│  │  · HandshakeVisualizer           │                             │
│  │  · DisputeConsole (+ DisputePack)│                             │
│  └──────────────────────────────────┘                             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Container Startup Order

```
bank-b-proxy  (starts first, no deps)
     ↓ healthcheck passes
bank-a-proxy  (registers Ed25519 pubkey with bank-b-proxy via retry loop)
     ↓ healthcheck passes
bank-a-agent  (polls /trigger-status; waits for "Start Demo" button press)
bank-b-agent  (subscribes to bank-b-proxy SSE stream; reactive)
frontend      (nginx serves static build; browser connects to :3001/:3002)
```

`bank-a-proxy` retries `POST bank-b-proxy:3002/register-peer-key` up to 25 times at 1-second intervals. The healthcheck has `start_period: 40s` to give the build and startup time.

---

## Three-Phase Handshake (per transaction)

```
bank-a-agent          bank-a-proxy           bank-b-proxy
     │                     │                      │
     │ POST /invoke         │                      │
     │─────────────────────►│                      │
     │                      │  POST /accept        │
     │                      │  {intent, cost}      │
     │                      │─────────────────────►│ → ledger.append(INTENT_RECORD)   ← always first
     │                      │                      │ validate:
     │                      │                      │  1. TTL check
     │                      │                      │  2. nonce uniqueness
     │                      │                      │  3. Ed25519 sig verify
     │                      │                      │  4. risk budget check
     │                      │                      │
     │                      │  {acceptance}        │ → saveEnvelope(INTENT)
     │                      │◄─────────────────────│ → saveEnvelope(ACCEPTANCE)
     │                      │                      │ → sseBus(intent-accepted)
     │                      │                      │
     │                      │ executeToolStub()    │
     │                      │──────────────┐       │
     │                      │◄─────────────┘       │
     │                      │                      │
     │                      │  POST /executed      │
     │                      │  {execution}  ─ ─ ─►│ → ledger.append(EXECUTION)
     │                      │  (fire-and-forget)   │ → saveEnvelope(EXECUTION)
     │                      │                      │ → budgetEngine.recordSpend()
     │                      │                      │ → sseBus(execution-complete)
     │                      │
     │                      │ buildContentProvenanceReceipt()
     │                      │ saveEnvelope(INTENT, ACCEPTANCE, EXECUTION, PROVENANCE)
     │                      │ sseBus(execution-complete)
     │                      │
     │ {mcpResult + _a2a}   │
     │◄─────────────────────│
```

---

## Breach Path (budget exceeded)

```
bank-a-proxy           bank-b-proxy
     │                      │
     │  POST /accept        │
     │  {intent, cost=50k}  │
     │─────────────────────►│ → ledger.append(INTENT_RECORD)   ← always first
     │                      │ budgetEngine.check() → DENIED
     │                      │   build signed AcceptanceReceipt(decision: REJECTED)
     │                      │ → ledger.append(ACCEPTANCE_RECORD, decision:REJECTED)
     │                      │ → saveEnvelope(INTENT)
     │                      │ → saveEnvelope(DENIED)            ← real signed receipt
     │                      │ → sseBus(intent-rejected)
     │                      │
     │  400 {error, code}   │
     │◄─────────────────────│
     │
     │ returns MCP error to /invoke caller
```

The INTENT and signed REJECTION are recorded in the DAG ledger before the error is returned. `GET /dispute/:traceId` returns a populated pack for rejected transactions (2 entries: INTENT_RECORD + ACCEPTANCE_RECORD with `decision: "REJECTED"`).

---

## Core Library Integration

Both proxy servers wrap `@trustagentai/a2a-core` (located in `trust-agent/`). The library is installed as a `file:` local dependency — `--install-links` ensures it is physically copied into `node_modules` (not symlinked) for multi-stage Docker compatibility.

**Bank-A proxy uses:**
- `generateKeyPair(kid)` — ephemeral Ed25519 key at startup
- `ProxyAGateway` — orchestrates the full outbound handshake
- `buildContentProvenanceReceipt()` — v0.5 artifact binding after success

**Bank-B proxy uses:**
- `generateKeyPair(kid)` — ephemeral Ed25519 key at startup
- `ProxyBGateway` — validates inbound intents; builds AcceptanceReceipt
- `DAGLedger` — in-memory DAG with Merkle batch support; feeds `/dispute/:id`
- `NonceRegistry` — anti-replay with TTL + 5s skew tolerance
- `RiskBudgetEngine` — per-DID policy enforcement

---

## DIDs and Policy Constants

| Constant | Value | Where Used |
|---|---|---|
| Bank-A proxy kid | `did:workload:bank-a-proxy#key-1` | IntentEnvelope.signatures[].kid |
| Bank-A initiator DID | `did:workload:bank-a-agent` | IntentEnvelope.initiator.did; RiskBudgetEngine policy key |
| Bank-B proxy kid | `did:workload:bank-b-proxy#key-1` | AcceptanceReceipt.signatures[].kid |
| Bank-B target DID | `did:workload:bank-b-proxy` | IntentEnvelope.target.did |
| Risk budget | maxSingleActionUsd: $10k, dailyBudgetUsd: $10k | Registered in bank-b-proxy at startup |
| Allowed tools | `get_security_report`, `execute_wire_transfer` | RiskBudgetEngine policy |

---

## SQLite Schema (identical on both nodes)

```sql
-- Stores all signed cryptographic artifacts
envelopes (
  id TEXT PRIMARY KEY,          -- <trace_id>:<type> e.g. "urn:uuid:...:intent"
  type TEXT NOT NULL,           -- INTENT | ACCEPTANCE | EXECUTION | PROVENANCE | DENIED
  trace_id TEXT NOT NULL,       -- urn:uuid:... links the 3-phase set
  raw_payload TEXT NOT NULL,    -- JSON.stringify of the full envelope object
  signature TEXT NOT NULL,      -- JSON.stringify of signatures array (real Ed25519 sig, including for DENIED)
  created_at TEXT NOT NULL
);

-- Hash-linked call graph (populated from DAGLedger on bank-b)
ledger_chain (
  sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  prev_hash TEXT,               -- NULL for first entry
  node_hash TEXT NOT NULL,      -- SHA256(JCS(entry))
  timestamp TEXT NOT NULL
);

-- Real-time D4 budget state
risk_budgets (
  entity_did TEXT PRIMARY KEY,
  max_limit REAL NOT NULL,
  current_spend REAL NOT NULL DEFAULT 0
);

-- v0.5 content provenance (bank-a only)
provenance (
  content_hash TEXT PRIMARY KEY,   -- SHA256(tool_output_bytes)
  tx_id TEXT NOT NULL,             -- trace_id
  receipt_sig TEXT NOT NULL,       -- JSON.stringify of CPR signatures
  created_at TEXT NOT NULL
);
```

---

## SSE Event Reference

Both proxies broadcast SSE events on `GET /events`. The frontend subscribes separately to each.

| Event | Source Proxy | Payload |
|---|---|---|
| `thought` | Both | `{ source: "bank-a"\|"bank-b", text, ts }` |
| `demo-triggered` | Bank-A | `{ ts }` |
| `demo-reset` | Both | `{ ts }` |
| `intent-accepted` | Bank-B | `{ traceId, tool, cost, ts }` |
| `intent-rejected` | Bank-B | `{ traceId, tool, cost, errorCode, reason, ts }` |
| `execution-complete` | Bank-A | `{ traceId, status, tool, cost, ts }` |
| `envelope` | Bank-A | `{ type, traceId, ts }` (lightweight, triggers refetch) |

Wire format (standard SSE):
```
event: intent-accepted
data: {"traceId":"urn:uuid:...","tool":"get_security_report","cost":5000,"ts":"..."}

```

---

## API Reference

### Bank-A Proxy (`http://localhost:3001`)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{ ok: true }` |
| POST | `/trigger` | Sets demo flag; broadcasts `demo-triggered` SSE |
| GET | `/trigger-status` | `{ triggered: boolean }` |
| POST | `/trigger-done` | Resets `triggered` to false (no DB clear); called by agent after each cycle |
| POST | `/reset` | Resets `triggered`, clears SQLite, broadcasts `demo-reset` SSE |
| POST | `/thought` | Body: `{ text }` — broadcasts `thought` SSE |
| GET | `/events` | SSE stream |
| GET | `/envelopes` | All SQLite envelope rows |
| POST | `/invoke` | Body: `{ tool, args, cost }` — runs full A2A handshake |

### Bank-B Proxy (`http://localhost:3002`)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{ ok: true }` |
| POST | `/register-peer-key` | Body: `{ kid, publicKeyHex }` — registers Bank-A pubkey |
| POST | `/reset` | Recreates in-memory state (ledger, nonces, budget), clears SQLite, broadcasts `demo-reset` SSE |
| POST | `/thought` | Body: `{ text }` — broadcasts `thought` SSE |
| GET | `/events` | SSE stream |
| GET | `/envelopes` | All SQLite envelope rows |
| POST | `/accept` | Body: `{ intent: IntentEnvelope, estimated_cost_usd }` |
| POST | `/executed` | Body: `{ execution: ExecutionEnvelope }` |
| GET | `/dispute/:id` | Full dispute pack (records + entries + Merkle proofs); populated for both accepted and rejected traces |
| POST | `/flush` | Force Merkle batch commit; returns `{ batch }` |

---

## Frontend Architecture

`resetToken: number` is owned by `App.tsx` and incremented each time the user clicks "↺ Clear messages and restart demo". It is passed as a prop to all three panels. `useSSE` and `useEnvelopes` include `resetToken` in their `useEffect` dependency arrays — when it changes, they clear accumulated state and re-subscribe/re-fetch.

```
App.tsx  (3-column grid layout, owns resetToken state)
├── ThoughtStream.tsx  { resetToken }
│   ├── useSSE(PROXY_A/events, "thought", resetToken)
│   └── useSSE(PROXY_B/events, "thought", resetToken)
│       → merged, sorted by ts, auto-scroll
│
├── HandshakeVisualizer.tsx  { resetToken, onReset }
│   ├── useSSE(PROXY_A/events, "demo-triggered",    resetToken)
│   ├── useSSE(PROXY_A/events, "execution-complete", resetToken)
│   ├── useSSE(PROXY_B/events, "intent-accepted",   resetToken)
│   └── useSSE(PROXY_B/events, "intent-rejected",   resetToken)
│       → useMemo derives Trace[] from accumulated events
│       → "▶ Start Demo" button → POST PROXY_A/trigger (shown when !running)
│       → "↺ Clear messages and restart demo" button
│           shown when running && execRaw.length > 0 && rejectedRaw.length > 0
│           → POST PROXY_A/reset + POST PROXY_B/reset → calls onReset()
│
└── DisputeConsole.tsx  { resetToken }
    ├── tab: Envelopes
    │   ├── useEnvelopes(PROXY_A, resetToken)  — polls /envelopes every 3s
    │   └── useEnvelopes(PROXY_B, resetToken)
    │       → node selector (Bank-A | Bank-B)
    │       → clickable rows expand raw_payload JSON
    │       → DENIED rows highlighted red
    └── tab: Dispute Pack
        ├── trace selector (populated from useEnvelopes; clears on resetToken change)
        ├── Load  → GET PROXY_B/dispute/:traceId
        └── Flush + Load  → POST PROXY_B/flush → GET /dispute/:traceId
```

---

## Dockerfile Strategy

Both proxy Dockerfiles use `context: .` (repo root) to access both `trust-agent/` and `Bank-A/proxy/` in one build context.

**Key steps in order:**
1. `npm ci --ignore-scripts` on trust-agent (installs deps, no lifecycle scripts)
2. `tsc` on trust-agent (produces `dist/`)
3. `npm install --install-links` on the proxy (resolves `file:../../trust-agent` as a physical copy, not symlink)
4. `tsc` on the proxy (produces `dist/server.js` — rootDir is `src`)
5. Runtime stage copies only `dist/` + `node_modules/` + `package.json`

`--install-links` is required because `file:` deps create symlinks by default, which break in multi-stage builds when the source path (`/workspace/trust-agent/`) does not exist in the runtime stage.

---

## Known Limitations

1. **In-memory keys**: Proxy keys are ephemeral (regenerated on restart). After `docker compose restart bank-a-proxy`, Bank-A re-registers its new key with Bank-B automatically via the retry loop. If Bank-B also restarts, Bank-A's old key is no longer registered — a full `docker compose up` resolves this.

2. **In-memory nonce registry**: The `NonceRegistry` and `DAGLedger` are not persisted across container restarts. Calling `POST /reset` on Bank-B recreates both (plus the budget engine) in-memory without a restart. This is by design for demo purposes.

3. **Tool execution stub**: The actual tool output is a mock JSON object. In production, `executeTool` would call a real vendor API or MCP server.

4. **L2 anchoring**: `ledger.flush()` commits a Merkle batch in memory. The `anchored_at` field remains null (real Base/Arbitrum anchoring is a v0.5+ roadmap item).

5. **Budget not persisted**: Risk budget `current_spend` lives in `RiskBudgetEngine` in-memory only. SQLite `risk_budgets` table exists for schema completeness but is not populated in this demo.
