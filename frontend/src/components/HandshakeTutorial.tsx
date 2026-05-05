const PHASES = [
  {
    phase: "01  INTENT",
    color: "#7bb3ff",
    actor: "Bank-A → Bank-B",
    desc: "Bank-A's agent signs an IntentEnvelope with Ed25519. Contains: tool name, args hash, nonce, TTL, initiator DID. Forwarded to Bank-B Trust Proxy for policy validation.",
  },
  {
    phase: "02  ACCEPTANCE",
    color: "#4caf50",
    actor: "Bank-B",
    desc: "Bank-B validates TTL → nonce uniqueness → Ed25519 signature → risk budget. Signs AcceptanceReceipt. Binding consent is now cryptographically on-record.",
  },
  {
    phase: "03  EXECUTION",
    color: "#a78bfa",
    actor: "Bank-A + Bank-B (dual-sign)",
    desc: "Tool executes. Bank-A builds ExecutionEnvelope with output hash. Bank-B dual-signs (D1 Non-repudiation). All three artifacts bound via trace_id — neither party can deny the transaction.",
  },
  {
    phase: "04  ANCHOR",
    color: "#f0a500",
    actor: "Bank-B Accounting Agent",
    desc: "Bank-B batches envelope signatures into a SHA-256 Merkle tree and anchors the root to Base Sepolia as a 0-ETH self-transaction. Immutable timestamp on L2.",
  },
];

export function HandshakeTutorial() {
  return (
    <div style={{ padding: "14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ color: "#3a3a4a", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 2 }}>
        TrustAgentAI v0.5 — A2A Protocol Guide
      </div>
      <div style={{ color: "#2a2a3a", fontSize: 9, marginBottom: 6 }}>
        No transactions yet. Press "Start Demo" to begin.
      </div>

      {PHASES.map((s, i) => (
        <div key={i} style={{
          background: "#07070d", borderRadius: 4, borderLeft: `2px solid ${s.color}44`,
          padding: "7px 10px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ color: s.color + "99", fontSize: 10, fontWeight: "bold", letterSpacing: 0.5 }}>{s.phase}</span>
            <span style={{ color: "#2a2a3a", fontSize: 9 }}>{s.actor}</span>
          </div>
          <div style={{ color: "#3a3a4a", fontSize: 9, lineHeight: 1.6 }}>{s.desc}</div>
        </div>
      ))}

      <div style={{
        background: "#050508", borderRadius: 4, border: "1px solid #111",
        padding: "8px 10px", marginTop: 4,
        fontFamily: "monospace", fontSize: 9, lineHeight: 2,
      }}>
        <div style={{ color: "#7bb3ff44" }}>IntentEnvelope(signed: A) ──────────────</div>
        <div style={{ color: "#2a2a3a", paddingLeft: 8 }}>↓ validate TTL · nonce · sig · budget</div>
        <div style={{ color: "#4caf5044" }}>AcceptanceReceipt(signed: B) ──────────</div>
        <div style={{ color: "#2a2a3a", paddingLeft: 8 }}>↓ execute tool</div>
        <div style={{ color: "#a78bfa44" }}>ExecutionEnvelope(signed: A + B) ───────</div>
        <div style={{ color: "#2a2a3a", paddingLeft: 8 }}>↓ Merkle batch → Base Sepolia</div>
        <div style={{ color: "#f0a50044" }}>0x{"{merkle_root}"} anchored on L2</div>
      </div>
    </div>
  );
}
