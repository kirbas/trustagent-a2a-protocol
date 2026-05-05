# Agent Context — TrustAgentAI Demo Infrastructure

This document is the single source of truth for an AI agent picking up work on this repository. Read this before touching any code.

---

## What This Repo Is

**`trust-agent/`** is the npm package `@trustagentai/a2a-core` v0.5.0-alpha.0. It is a cryptographic accountability layer for MCP (Model Context Protocol) tool calls. **Do not modify it** unless explicitly asked to change the core protocol.

**`Bank-A/`, `Bank-B/`, `frontend/`, `docker-compose.yml`** form the Procurement Handshake Demo — a Dockerized showcase of the protocol with a React visualizer.

---

## Repository Layout

```
Trust-Agent/
├── trust-agent/                   @trustagentai/a2a-core npm package (CORE — READ ONLY)
│   ├── src/
│   │   ├── crypto.ts              Ed25519 key gen, signing, SHA-256, JCS
│   │   ├── envelopes.ts           IntentEnvelope, AcceptanceReceipt, ExecutionEnvelope, ContentProvenanceReceipt builders
│   │   ├── ledger.ts              DAGLedger, MerkleBatch, getDisputePack(), computeMerkleRoot()
│   │   ├── nonce-registry.ts      NonceRegistry (anti-replay, TTL + 5s skew)
│   │   ├── risk-budget.ts         RiskBudgetEngine, AgentPolicy
│   │   ├── trust-proxy.ts         ProxyAGateway, ProxyBGateway, McpToolCall, McpToolResult
│   │   └── index.ts               Re-exports everything
│   ├── dist/                      Compiled JS + .d.ts (pre-built; needed for `file:` dep)
│   ├── package.json               "type":"module", NodeNext, ES2022
│   └── package-lock.json          Used by npm ci in Dockerfiles
│
├── Bank-A/
│   ├── proxy/
│   │   ├── src/
│   │   │   ├── server.ts          Express app: /invoke /trigger /trigger-done /reset /thought /events /envelopes /cross-check /health
│   │   │   ├── db.ts              better-sqlite3: 2-table schema (envelopes, provenance), saveEnvelope(), getEnvelopesByTraceId(), clearEnvelopes()
│   │   │   ├── sse.ts             SseBus: addClient(res), broadcast(event, data)
│   │   │   └── key-exchange.ts    registerWithProxyB() retry loop (25× @ 1s)
│   │   ├── package.json           ESM, file: dep on trust-agent
│   │   ├── tsconfig.json          NodeNext, rootDir:src, outDir:dist
│   │   └── Dockerfile             context:. (repo root), --install-links
│   │   └── Dockerfile
│   └── agent/
│       ├── agent.py               Polls /trigger-status → runs 2 scenarios → loops back (while True)
│       ├── requirements.txt       requests==2.31.0 only
│       └── Dockerfile
│
├── Bank-B/
│       ├── domain/
│       │   ├── merkle.py          build_merkle_tree(), verify_proof()
│       │   └── models.py          Envelope, AnchorRecord dataclasses
│       ├── infra/
│       │   ├── db.py              SQLiteRepository: envelopes + anchors + anchor_leaves tables
│       │   └── notary.py          BlockchainNotary: EIP-1559 0-ETH self-tx to Base Sepolia
│       ├── app/
│       │   └── accounting_agent.py  AccountingAgent.run(): seed → merkle → anchor → verify proofs
│       ├── main.py                Entry point; loads root .env via find_dotenv()
│       └── requirements.txt       web3>=6.0.0, python-dotenv>=1.0.0
│
├── Bank-B/
│   ├── proxy/
│   │   ├── src/
│   │   │   ├── db.ts              better-sqlite3: 3-table schema (envelopes, anchors, anchor_leaves), /data/bank-b.db, clearEnvelopes(), getEnvelopesByTraceId()
│   │   │   └── sse.ts             identical SseBus
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   ├── agent/
│   │   ├── agent.py               Long-running SSE subscriber → emits vendor thoughts
│   │   ├── requirements.txt
│   │   └── Dockerfile
│   └── merkle-anchor/    Python DDD service: standalone Merkle anchor Flask app (port 5001)
│       ├── domain/
│       │   ├── merkle.py          build_merkle_tree(), verify_proof()
│       │   └── models.py          Envelope, AnchorRecord dataclasses
│       ├── infra/
│       │   ├── db.py              SQLiteRepository: reads proxy's envelopes table, writes to anchors/anchor_leaves
│       │   └── notary.py          BlockchainNotary: EIP-1559 0-ETH self-tx to Base Sepolia
│       ├── app/
│       │   └── accounting_agent.py  AccountingAgent.run(): fetch unanchored → merkle → anchor
│       ├── main.py                Flask HTTP server /anchor
│       └── requirements.txt       Flask, web3>=6.0.0, python-dotenv>=1.0.0
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx                3-column grid; owns resetToken state + onReset callback
│   │   ├── types.ts               ThoughtEvent, HandshakeEvent, Envelope, DisputePack, AnchorEvent
│   │   ├── hooks/
│   │   │   ├── useSSEMulti.ts      Multi-event source wrapper
│   │   │   └── useEnvelopes.ts    polls /envelopes every 3s; resetToken param clears + re-fetches
│   │   └── components/
│   │       ├── ErrorBoundary.tsx  React class error boundary for offline panels
│   │       ├── ThoughtStream.tsx  merged Bank-A + Bank-B thoughts + Protocol mode
│   │       ├── HandshakeTutorial.tsx 3-phase protocol zero-state guide
│   │       ├── HandshakeVisualizer.tsx trace timelines; Start Demo / Clear+restart buttons
│   │       └── DisputeConsole.tsx Envelopes, Dispute Pack, Anchor to L2, Verify Anchor, Provenance Verifier, Cross-Check
│   │           ├── EvidenceBundle.tsx [INTENT] → [ACCEPTANCE] → [EXECUTION] causal chain
│   │           ├── ForensicDetail.tsx Syntax-highlighted JSON viewer with proofs
│   │           └── ProvenanceVerifier.tsx Native browser drag-drop SHA-256 verification
│   ├── package.json               React 18, Vite 5, TypeScript
│   ├── tsconfig.json              bundler moduleResolution, vite/client types
│   ├── vite.config.ts
│   ├── index.html
│   ├── nginx.conf                 SPA fallback: try_files $uri /index.html
│   └── Dockerfile                 Vite build → nginx:alpine
│
├── docker-compose.yml             5 services: bank-b-proxy, bank-a-proxy, bank-a-agent, bank-b-agent, frontend
└── docs/
    ├── README.md                  Quick start, demo flow, verification commands
    ├── ARCHITECTURE.md            System diagram, API reference, SSE events, SQLite schema
    └── AGENT_CONTEXT.md           This file
```

---

## Critical Invariants — Never Break These

1. **`trust-agent/dist/` must be pre-built** before `npm install --install-links` runs on the proxy packages. The Dockerfiles do this in order. If you change trust-agent source, run `npm run build` in `trust-agent/` first.

2. **`--install-links`** must remain on `npm install` in both proxy Dockerfiles. Without it, `file:../../trust-agent` creates a symlink that breaks in multi-stage Docker builds.

3. **`rootDir: "src"` in proxy tsconfigs** ensures TypeScript outputs to `dist/server.js` (not `dist/src/server.js`). The Dockerfiles use `CMD ["node", "dist/server.js"]`.

4. **JCS Canonicalization (RFC 8785)**: All hashes (content hashes, node hashes) MUST use JCS canonicalization via `sha256Json` to ensure reproducibility cross-platform. Do not use `JSON.stringify`.

5. **`spec_version: "0.5"`** in all envelopes. The library hardcodes this.

5. **D1 Non-repudiation (Dual-Signing)**: Bank-B dual-signs the `ExecutionEnvelope` in the `/executed` handler before persistence. This ensures that the execution outcome is cryptographically binding for both parties.

6. **SSE Resiliency**: The Bank-B agent uses a `while True` loop with a 3s backoff to ensure the SSE connection is restored if the proxy restarts or the network drops.

7. **DID alignment**: `ProxyBGateway` validates the intent signature using `proxyAPublicKeys.get(sig.kid)`. The `kid` in the signature comes from Bank-A proxy's `KeyPair.kid = "did:workload:bank-a-proxy#key-1"`. The `RiskBudgetEngine` policy is keyed on `intent.initiator.did = "did:workload:bank-a-agent"`. These two values are different and must stay consistent.

6. **Reject events come from Bank-B**, not Bank-A. When a budget check fails, Bank-B's `/accept` broadcasts `intent-rejected` with the real `trace_id`. Bank-A's `/invoke` does NOT broadcast an additional `execution-complete` for rejected intents. Do not add one.

---

## Key Types from `@trustagentai/a2a-core`

```typescript
// All exported from the root import:
import {
  generateKeyPair,
  ProxyAGateway, ProxyBGateway,
  DAGLedger, NonceRegistry, RiskBudgetEngine,
  buildContentProvenanceReceipt,
  type McpToolCall, type McpToolResult,
  type IntentEnvelope, type AcceptanceReceipt, type ExecutionEnvelope,
  type KeyPair, type AgentPolicy,
} from "@trustagentai/a2a-core";

// ProxyAGateway config
interface ProxyAConfig {
  proxyKey: KeyPair;
  proxyBEndpoint: string;   // base URL, NOT including /accept
  ttlSeconds?: number;
}

// ProxyBGateway config
interface ProxyBConfig {
  proxyKey: KeyPair;
  proxyAPublicKeys: Map<string, Uint8Array>;  // kid → publicKey (mutable, populated by /register-peer-key)
  nonceRegistry: NonceRegistry;
  budgetEngine: RiskBudgetEngine;
  ledger: DAGLedger;
  ttlSeconds?: number;
}

// forwardToolCall — orchestrates entire outbound handshake
proxyA.forwardToolCall(mcpCall, async (call) => outputData): Promise<McpToolResult>

// handleIntent — always records intent first; returns signed AcceptanceReceipt or signed denial + error
proxyB.handleIntent(intent, estimatedCostUsd?): Promise<{ acceptance?, denial?, error?, errorCode? }>

// handleExecution — records execution in DAGLedger, calls budgetEngine.recordSpend() on COMPLETED
proxyB.handleExecution(execution): Promise<void>
```

---

## `/invoke` Flow (Bank-A proxy)

```typescript
// 1. Build McpToolCall with hardcoded DIDs
const call: McpToolCall = {
  jsonrpc: "2.0", id: randomUUID(), method: "tools/call",
  params: {
    name: tool,
    arguments: args,
    _initiator_did: "did:workload:bank-a-agent",     // ← must match RiskBudgetEngine policy DID
    _vc_ref: "vc:bank-a:compliance-cert-2026",
    _mcp_deployment_id: "did:workload:bank-b-proxy", // ← used as intent.target.did
    _tool_schema_hash: sha256(tool),
    _mcp_session_id: randomUUID(),
    _estimated_cost_usd: cost,
  }
};

// 2. Run full handshake (builds intent → gets acceptance → runs stub → builds execution → fires to /executed)
const result = await proxyA.forwardToolCall(call, async () => stubOutput);

// 3. On success: save INTENT, ACCEPTANCE, EXECUTION, PROVENANCE envelopes to SQLite
// 4. On error (result.error): return 400 — Bank-B already broadcast intent-rejected via SSE
```

---

## `/accept` Flow (Bank-B proxy)

```typescript
// Receives: { intent: IntentEnvelope, estimated_cost_usd: number }
const result = await proxyB.handleIntent(intent, estimated_cost_usd);

if (result.error) {
  // Save INTENT to SQLite
  // Save DENIED (= result.denial, the real signed AcceptanceReceipt) to SQLite
  // Broadcast intent-rejected SSE (with real trace_id)
  // Return 400 { error, errorCode }
  // Note: ledger already has INTENT_RECORD + ACCEPTANCE_RECORD(REJECTED) — dispute pack is populated
}

// Save INTENT + ACCEPTANCE to SQLite
// Broadcast intent-accepted SSE
// Return 200 { acceptance }
```

---

## Python Agent Design

**`Bank-A/agent/agent.py`** — loops, waiting for a button press each cycle:
1. Poll `GET /health` until ready
2. Loop forever:
   a. Poll `GET /trigger-status` until `{ triggered: true }`
   b. Scenario 1: `think()` × 3 → `POST /invoke` ($5k) → `think()` × 2
   c. `sleep(3)`
   d. Scenario 2: `think()` × 2 → `POST /invoke` ($50k) → `think()` × 2
   e. `POST /trigger-done` → sets `triggered = false` on the proxy
   f. Go back to (a) and wait for the next button press

The agent uses **reasoning-forward** logic: thoughts should focus on internal invariants and cryptographic expectations.

`POST /trigger-done` resets only the `triggered` flag without touching the DB. `POST /reset` (called by the UI's "↺ Clear" button) also clears the DB and broadcasts `demo-reset`.

`think(text)` = `POST /thought { text }` + `sleep(1.2)` to pace the UI.

**`Bank-B/agent/agent.py`** — long-running:
1. Poll `GET /health` until ready
2. Emit 3 initial "vendor ready" thoughts
3. Stream `GET /events` forever (wrapped in a `while True` reconnection loop)
4. On `intent-accepted`: emit 4 vendor thoughts
5. On `intent-rejected`: emit 2 vendor thoughts
6. On `execution-complete`: emit thoughts verifying **D1 Non-repudiation** (dual-signing)

---

## Environment Variables

| Variable | Service | Default | Description |
|---|---|---|---|
| `PORT` | bank-a-proxy | 3001 | Express listen port |
| `PORT` | bank-b-proxy | 3002 | Express listen port |
| `PROXY_B_URL` | bank-a-proxy | http://bank-b-proxy:3002 | Base URL for Proxy B |
| `DB_PATH` | bank-a-proxy | /data/bank-a.db | SQLite file path |
| `DB_PATH` | bank-b-proxy | /data/bank-b.db | SQLite file path |
| `FRONTEND_ORIGIN` | both proxies | http://localhost:3000 | CORS allowed origin |
| `PROXY_A_URL` | bank-a-agent | http://localhost:3001 | Bank-A proxy base URL |
| `PROXY_B_URL` | bank-b-agent | http://localhost:3002 | Bank-B proxy base URL |
| `ANCHOR_URL`  | bank-b-proxy | http://bank-b-anchor:5001 | Bank-B anchor service URL |
| `RPC_URL` | bank-b-anchor | (none) | Base Sepolia JSON-RPC URL (e.g. Alchemy) — required for anchoring |
| `PRIVATE_KEY` | bank-b-anchor | (none) | Burner wallet private key — required for anchoring; address derived automatically |

All sensitive values (`RPC_URL`, `PRIVATE_KEY`) live in a single root `.env` file (see `.env.example`). Docker Compose reads it via variable substitution. The Python `merkle-anchor` CLI finds it via `python-dotenv`'s `find_dotenv()` walk.

Frontend proxy URLs are hardcoded as `import.meta.env.VITE_PROXY_A_URL ?? "http://localhost:3001"` — set at Vite build time via `VITE_*` env vars if needed.

---

## Common Extension Points

### Re-run the demo without restarting containers
Click **↺ Clear messages and restart demo** in the UI. This calls `POST /reset` on both proxies (resets in-memory state and clears SQLite) and increments `resetToken` in the frontend (clears all SSE/envelope state). The Bank-A agent loops back to `wait_for_trigger()` automatically.

### Add a new scenario to Bank-A agent
Add a `scenario_*()` function in `Bank-A/agent/agent.py` following the existing pattern. Call `invoke()` with different `tool` and `cost` values.

### Add a new allowed tool
1. Add the tool name to `allowedTools` in `Bank-B/proxy/src/server.ts` (line ~34)
2. Add a corresponding call in `Bank-A/agent/agent.py`

### Change the risk budget limit
Edit `maxSingleActionUsd` and `dailyBudgetUsd` in `Bank-B/proxy/src/server.ts` (~line 31).

### Persist DAGLedger to SQLite
`DAGLedger.getAllEntries()` and `DAGLedger.getBatches()` return all data. Add a hook after `ledger.append()` in Bank-B's `/accept` and `/executed` handlers to write to `ledger_chain` table.

### Add a new frontend panel
Create a new component in `frontend/src/components/`, import it in `App.tsx`, add a column to the grid.

### Verify a Merkle anchor dispute pack
Paste a transaction hash from BaseScan into the "⛓ Anchor" tab in the Dispute Console.
Or hit the API directly:
```bash
curl "http://localhost:3002/verify/0x<txHash>" | python3 -m json.tool
```
Response includes `allValid: true/false`, per-leaf `proofValid`, and the full dispute pack JSON.
The downloaded file is named `{txHash}.json`.

---

## Build Commands (local, outside Docker)

```bash
# Build the core library
cd trust-agent && npm install && npm run build

# Build Bank-A proxy (from repo root)
cd Bank-A/proxy && npm install --install-links && npm run build

# Build Bank-B proxy
cd Bank-B/proxy && npm install --install-links && npm run build

# Build frontend
cd frontend && npm install && npm run build

# Run full demo with Docker
cd ../.. && docker compose up --build
```

---

## Debugging Tips

```bash
# Watch all container logs
docker compose logs -f

# Check Bank-B rejected intents
docker logs bank-b-proxy 2>&1 | grep REJECTED

# Inspect SQLite on a running container
docker exec bank-b-proxy sqlite3 /data/bank-b.db ".tables"
docker exec bank-b-proxy sqlite3 /data/bank-b.db "SELECT type, trace_id FROM envelopes ORDER BY created_at;"

# Manually trigger the demo (bypasses the UI button)
curl -X POST http://localhost:3001/trigger

# Force a Merkle batch flush
curl -X POST http://localhost:3002/flush

# Get a dispute pack for a trace (replace with actual trace_id)
curl "http://localhost:3002/dispute/urn%3Auuid%3A12345" | python3 -m json.tool

# Check how many SSE clients are connected
curl http://localhost:3001/health
curl http://localhost:3002/health
```
