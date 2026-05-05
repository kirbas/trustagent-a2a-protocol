import { useState, useMemo, useEffect } from "react";
import { useEnvelopes } from "../hooks/useEnvelopes";
import type { Envelope, DisputePack } from "../types";

const PROXY_A = import.meta.env.VITE_PROXY_A_URL ?? "http://localhost:3001";
const PROXY_B = import.meta.env.VITE_PROXY_B_URL ?? "http://localhost:3002";

const TYPE_COLOR: Record<string, string> = {
  INTENT: "#7bb3ff",
  ACCEPTANCE: "#4caf50",
  EXECUTION: "#a78bfa",
  PROVENANCE: "#f0a500",
  DENIED: "#f44336",
};

// ── Envelope audit row ──────────────────────────────────────────────────────

function EnvelopeRow({ env }: { env: Envelope }) {
  const [expanded, setExpanded] = useState(false);
  const color = TYPE_COLOR[env.type] ?? "#888";
  let pretty = env.raw_payload;
  try { pretty = JSON.stringify(JSON.parse(env.raw_payload), null, 2); } catch { /* keep raw */ }

  return (
    <div style={{ marginBottom: 4, borderRadius: 4, border: "1px solid #222", overflow: "hidden" }}>
      <div
        onClick={() => setExpanded((p) => !p)}
        style={{
          padding: "5px 8px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "#111",
          userSelect: "none",
        }}
      >
        <span style={{ color, fontSize: 10, fontWeight: "bold", minWidth: 80 }}>{env.type}</span>
        <span style={{ color: "#555", fontSize: 10, flex: 1 }}>{env.trace_id.replace(/^urn:uuid:/, "")}</span>
        <span style={{ color: "#444", fontSize: 10 }}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <pre style={{
          fontSize: 10, padding: 8, background: "#0d0d0d", color: "#c0c0c0",
          overflowX: "auto", maxHeight: 240, overflowY: "auto",
          borderTop: "1px solid #222", margin: 0, lineHeight: 1.5,
        }}>
          {pretty}
        </pre>
      )}
    </div>
  );
}

// ── Dispute pack (Bank-B DAG) ───────────────────────────────────────────────

function DisputePackView({ proxyBUrl, resetToken }: { proxyBUrl: string; resetToken: number }) {
  const envA = useEnvelopes(PROXY_A, resetToken);
  const envB = useEnvelopes(proxyBUrl, resetToken);
  const traceIds = useMemo(() => {
    return [...new Set([...envA, ...envB].map((e) => e.trace_id.replace(/^urn:uuid:/, "")))];
  }, [envA, envB]);
  const [selectedTrace, setSelectedTrace] = useState("");
  const [pack, setPack] = useState<DisputePack | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setSelectedTrace(""); setPack(null); }, [resetToken]);

  const fetchPack = async (id: string) => {
    if (!id) return;
    setLoading(true);
    const fullId = id.startsWith("urn:uuid:") ? id : `urn:uuid:${id}`;
    try {
      const r = await fetch(`${proxyBUrl}/dispute/${encodeURIComponent(fullId)}`);
      setPack(await r.json());
    } finally { setLoading(false); }
  };

  const flushAndFetch = async () => {
    await fetch(`${proxyBUrl}/flush`, { method: "POST" });
    await fetchPack(selectedTrace);
  };

  return (
    <div style={{ padding: "8px 10px", height: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          value={selectedTrace}
          onChange={(e) => { setSelectedTrace(e.target.value); setPack(null); }}
          style={{
            flex: 1, background: "#111", color: "#ccc", border: "1px solid #333",
            borderRadius: 3, padding: "3px 6px", fontFamily: "inherit", fontSize: 11,
          }}
        >
          <option value="">Select trace ID…</option>
          {traceIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button onClick={() => fetchPack(selectedTrace)} disabled={!selectedTrace || loading}
          style={{ padding: "3px 8px", background: "#1a2a3a", border: "1px solid #7bb3ff", borderRadius: 3, color: "#7bb3ff", cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>
          Load
        </button>
        <button onClick={flushAndFetch} disabled={!selectedTrace || loading}
          style={{ padding: "3px 8px", background: "#1a1a2a", border: "1px solid #a78bfa", borderRadius: 3, color: "#a78bfa", cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}
          title="Flush Merkle batch then load dispute pack">
          Flush + Load
        </button>
      </div>
      {!selectedTrace && <div style={{ color: "#444", fontSize: 11 }}>Select a trace ID to view its Dispute Pack.</div>}
      {loading && <div style={{ color: "#666", fontSize: 11 }}>Loading…</div>}
      {pack && (
        <pre style={{
          flex: 1, fontSize: 10, background: "#0d0d0d", color: "#c0c0c0",
          padding: 8, borderRadius: 4, border: "1px solid #222",
          overflowY: "auto", lineHeight: 1.5, margin: 0,
        }}>
          {JSON.stringify(pack, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Anchor verification panel ───────────────────────────────────────────────

interface VerifyLeaf {
  leafIndex: number;
  envelopeId: string;
  traceId: string | null;
  envelopeType: string | null;
  leafHash: string;
  proofPath: Array<{ hash: string; position: string }>;
  proofValid: boolean;
}

interface VerifyResult {
  ok: boolean;
  txHash: string;
  blockNumber: number;
  merkleRoot: string;
  batchId: string;
  anchoredAt: string;
  leafCount: number;
  allValid: boolean;
  basescanUrl: string;
  leaves: VerifyLeaf[];
}

function LeafRow({ leaf }: { leaf: VerifyResult["leaves"][0] }) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const typeColor = TYPE_COLOR[leaf.envelopeType ?? ""] ?? "#666";
  return (
    <div style={{
      background: "#0d0d0d", borderRadius: 4, 
      border: `1px solid ${leaf.proofValid ? "#1a3a1a" : "#3a1a1a"}`,
      marginBottom: 4, overflow: "hidden"
    }}>
      <div 
        onClick={() => setLocalExpanded(!localExpanded)}
        style={{
          padding: "7px 10px", display: "grid", gridTemplateColumns: "18px 80px 1fr auto 20px",
          gap: "0 8px", alignItems: "center", fontSize: 10, cursor: "pointer"
        }}
      >
        <span style={{ color: "#444" }}>#{leaf.leafIndex}</span>
        <span style={{ color: typeColor, fontWeight: "bold" }}>{leaf.envelopeType ?? "—"}</span>
        <span style={{ color: "#555" }}>
          {(leaf.traceId || leaf.envelopeId).replace(/^urn:uuid:/, "")}
        </span>
        <span style={{ color: leaf.proofValid ? "#4caf50" : "#f44336", fontWeight: "bold" }}>
          {leaf.proofValid ? "✓" : "✗"}
        </span>
        <span style={{ color: "#444" }}>{localExpanded ? "▲" : "▼"}</span>
      </div>
      {localExpanded && (
        <pre style={{
          fontSize: 9, padding: 8, background: "#050505", color: "#888",
          margin: 0, borderTop: "1px solid #1a1a1a", overflowX: "auto"
        }}>
          {JSON.stringify((leaf as any).payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function AnchorVerifyView() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);

  const verify = async () => {
    const txHash = input.trim();
    if (!txHash) return;
    setLoading(true);
    setResult(null);
    setNotFound(false);
    try {
      const r = await fetch(`${PROXY_B}/verify/${encodeURIComponent(txHash)}`);
      if (r.status === 404) { setNotFound(true); return; }
      const data = await r.json();
      setResult(data);
    } catch (err) {
      console.error("Verify failed:", err);
      alert("Verify failed: " + (err instanceof Error ? err.message : String(err)));
    } finally { setLoading(false); }
  };

  const download = () => {
    if (!result) return;
    const filename = `${result.txHash}.json`;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const statusColor = result ? (result.allValid ? "#4caf50" : "#f44336") : notFound ? "#f44336" : "#333";
  const statusBorder = result ? (result.allValid ? "#1a3a1a" : "#3a1a1a") : notFound ? "#3a1a1a" : "#222";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "8px 10px", gap: 8 }}>
      {/* Input row */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setResult(null); setNotFound(false); }}
          onKeyDown={(e) => e.key === "Enter" && verify()}
          placeholder="Paste tx hash (0x…)"
          style={{
            flex: 1, background: "#111", color: "#ccc", border: `1px solid ${statusColor}`,
            borderRadius: 3, padding: "4px 8px", fontFamily: "monospace", fontSize: 11,
            outline: "none", transition: "border-color 0.2s",
          }}
        />
        <button
          onClick={verify}
          disabled={!input.trim() || loading}
          style={{
            padding: "4px 12px", background: "#1a2a3a", border: "1px solid #7bb3ff",
            borderRadius: 3, color: "#7bb3ff", cursor: "pointer", fontFamily: "inherit", fontSize: 11,
            opacity: !input.trim() || loading ? 0.5 : 1,
          }}
        >
          {loading ? "…" : "Verify"}
        </button>
        {result && (
          <button
            onClick={download}
            style={{
              padding: "4px 10px", background: "#1a2a1a", border: "1px solid #4caf50",
              borderRadius: 3, color: "#4caf50", cursor: "pointer", fontFamily: "inherit", fontSize: 11,
            }}
            title={`Download ${result.txHash}.json`}
          >
            ↓ JSON
          </button>
        )}
      </div>

      {/* Not found */}
      {notFound && (
        <div style={{
          background: "#1a0000", border: "1px solid #3a1a1a", borderRadius: 6,
          padding: "10px 12px", display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ color: "#f44336", fontSize: 16 }}>✗</span>
          <span style={{ color: "#f44336", fontSize: 11 }}>
            Transaction not found in local anchor database.
          </span>
        </div>
      )}

      {/* Result */}
      {result && (
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Status banner */}
          <div style={{
            background: result.allValid ? "#001a00" : "#1a0000",
            border: `1px solid ${result.allValid ? "#1a4a1a" : "#4a1a1a"}`,
            borderRadius: 6, padding: "10px 12px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ color: "#f0a500", fontSize: 11, fontWeight: "bold", letterSpacing: 1 }}>
                ⛓ MERKLE ANCHOR
              </span>
              <span style={{ color: result.allValid ? "#4caf50" : "#f44336", fontSize: 11, fontWeight: "bold" }}>
                {result.allValid ? "✓ ALL PROOFS VALID" : "✗ PROOF FAILURE"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px", fontSize: 10 }}>
              <span style={{ color: "#555" }}>Block</span>
              <span style={{ color: "#ccc" }}>{result.blockNumber}</span>

              <span style={{ color: "#555" }}>Root</span>
              <span style={{ color: "#888", fontFamily: "monospace", wordBreak: "break-all" }}>
                {result.merkleRoot}
              </span>

              <span style={{ color: "#555" }}>Leaves</span>
              <span style={{ color: "#ccc" }}>{result.leafCount}</span>

              <span style={{ color: "#555" }}>Anchored</span>
              <span style={{ color: "#ccc" }}>{new Date(result.anchoredAt).toLocaleString()}</span>

              <span style={{ color: "#555" }}>Tx</span>
              <a href={result.basescanUrl} target="_blank" rel="noreferrer"
                style={{ color: "#f0a500", textDecoration: "none", wordBreak: "break-all" }}>
                {result.txHash} ↗
              </a>
            </div>
          </div>

          {/* Leaf table */}
          <div style={{ color: "#555", fontSize: 10, paddingLeft: 2 }}>
            Merkle leaves — proofs re-derived and verified against on-chain root:
          </div>
          {result.leaves.map((leaf) => (
            <LeafRow key={leaf.leafIndex} leaf={leaf} />
          ))}

          {/* Full JSON */}
          <div style={{ color: "#555", fontSize: 10, paddingLeft: 2, marginTop: 4 }}>
            Full dispute pack JSON:
          </div>
          <pre style={{
            fontSize: 10, background: "#0d0d0d", color: "#c0c0c0",
            padding: 10, borderRadius: 4, border: `1px solid ${statusBorder}`,
            overflowY: "auto", lineHeight: 1.5, margin: 0, maxHeight: 320,
          }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Cross-Check View ────────────────────────────────────────────────────────

function CrossCheckView({ resetToken }: { resetToken: number }) {
  const envA = useEnvelopes(PROXY_A, resetToken);
  const traceIds = useMemo(() => [...new Set(envA.map((e) => e.trace_id.replace(/^urn:uuid:/, "")))], [envA]);
  const [selectedTrace, setSelectedTrace] = useState("");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setSelectedTrace(""); setResult(null); }, [resetToken]);

  const crossCheck = async () => {
    const id = selectedTrace.trim();
    if (!id) return;
    setLoading(true);
    try {
      const fullId = id.startsWith("urn:uuid:") ? id : `urn:uuid:${id}`;
      const r = await fetch(`${PROXY_A}/cross-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traceId: fullId }),
      });
      setResult(await r.json());
    } finally { setLoading(false); }
  };

  return (
    <div style={{ padding: "8px 10px", height: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          list="trace-ids-list"
          value={selectedTrace}
          onChange={(e) => { setSelectedTrace(e.target.value); setResult(null); }}
          onKeyDown={(e) => e.key === "Enter" && crossCheck()}
          placeholder="Select or enter trace ID…"
          style={{
            flex: 1, background: "#111", color: "#ccc", border: "1px solid #333",
            borderRadius: 3, padding: "3px 6px", fontFamily: "inherit", fontSize: 11,
            outline: "none"
          }}
        />
        <datalist id="trace-ids-list">
          {traceIds.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button onClick={crossCheck} disabled={!selectedTrace.trim() || loading}
          style={{ padding: "4px 12px", background: "#1a2a3a", border: "1px solid #7bb3ff", borderRadius: 3, color: "#7bb3ff", cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>
          {loading ? "Checking..." : "Cross-Check"}
        </button>
      </div>
      {!selectedTrace && <div style={{ color: "#444", fontSize: 11 }}>Select a trace ID to verify bilateral identicality.</div>}
      {result && (
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{
            background: result.synced ? "#001a00" : "#1a0000",
            border: `1px solid ${result.synced ? "#1a4a1a" : "#4a1a1a"}`,
            borderRadius: 6, padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center"
          }}>
            <span style={{ color: "#fff", fontSize: 12, fontWeight: "bold" }}>Bilateral Integrity Status</span>
            <span style={{ color: result.synced ? "#4caf50" : "#f44336", fontSize: 12, fontWeight: "bold" }}>
              {result.synced ? "✓ SYNCED" : "✗ MISMATCH"}
            </span>
          </div>
          {result.details?.map((d: any) => (
            <div key={d.type} style={{
              background: "#0d0d0d", borderRadius: 4, padding: "7px 10px",
              border: `1px solid ${d.match ? "#1a3a1a" : "#3a1a1a"}`,
              display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10,
            }}>
              <span style={{ color: TYPE_COLOR[d.type] ?? "#fff", fontWeight: "bold" }}>{d.type}</span>
              <span style={{ color: d.match ? "#4caf50" : "#f44336" }}>{d.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function DisputeConsole({ resetToken = 0 }: { resetToken?: number }) {
  const [tab, setTab] = useState<"envelopes" | "dispute" | "anchor" | "cross_check">("envelopes");
  const [nodeTab, setNodeTab] = useState<"bank-a" | "bank-b">("bank-a");

  const envA = useEnvelopes(PROXY_A, resetToken);
  const envB = useEnvelopes(PROXY_B, resetToken);
  const envelopes = nodeTab === "bank-a" ? envA : envB;

  const tabBtn = (label: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        padding: "4px 10px",
        background: active ? "#1a2a3a" : "transparent",
        border: `1px solid ${active ? "#7bb3ff" : "#333"}`,
        borderRadius: 3,
        color: active ? "#7bb3ff" : "#666",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 11,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{
        padding: "10px 12px", borderBottom: "1px solid #222",
        display: "flex", flexDirection: "column", justifyContent: "center", gap: 6,
        minHeight: 84, boxSizing: "border-box",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            color: "#7bb3ff", fontWeight: "bold", fontSize: 12,
            letterSpacing: 1, textTransform: "uppercase", marginRight: 4,
          }}>
            Dispute Console
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {tabBtn("Envelopes", tab === "envelopes", () => setTab("envelopes"))}
            {tabBtn("Dispute Pack", tab === "dispute", () => setTab("dispute"))}
            {tabBtn("Verify Anchor", tab === "anchor", () => setTab("anchor"))}
            {tabBtn("Cross-Check", tab === "cross_check", () => setTab("cross_check"))}
          </div>
        </div>

        {tab === "envelopes" && (
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            {tabBtn("Bank-A", nodeTab === "bank-a", () => setNodeTab("bank-a"))}
            {tabBtn("Bank-B", nodeTab === "bank-b", () => setNodeTab("bank-b"))}
            <span style={{ color: "#444", fontSize: 10, alignSelf: "center", marginLeft: "auto" }}>
              {envelopes.length} records
            </span>
          </div>
        )}
      </div>

      {tab === "envelopes" && (
        <>
          <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px" }}>
            {envelopes.length === 0 && <div style={{ color: "#444", fontSize: 11 }}>No envelopes yet.</div>}
            {envelopes.map((env) => <EnvelopeRow key={env.id} env={env} />)}
          </div>
        </>
      )}

      {tab === "dispute" && (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <DisputePackView proxyBUrl={PROXY_B} resetToken={resetToken} />
        </div>
      )}

      {tab === "anchor" && (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <AnchorVerifyView />
        </div>
      )}

      {tab === "cross_check" && (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <CrossCheckView resetToken={resetToken} />
        </div>
      )}
    </div>
  );
}
