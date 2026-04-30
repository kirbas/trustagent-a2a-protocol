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

function EnvelopeRow({ env }: { env: Envelope }) {
  const [expanded, setExpanded] = useState(false);
  const color = TYPE_COLOR[env.type] ?? "#888";
  let pretty = env.raw_payload;
  try { pretty = JSON.stringify(JSON.parse(env.raw_payload), null, 2); } catch { /* keep raw */ }

  return (
    <div
      style={{
        marginBottom: 4,
        borderRadius: 4,
        border: `1px solid #222`,
        overflow: "hidden",
      }}
    >
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
        <span style={{ color: "#555", fontSize: 10, flex: 1 }}>…{env.trace_id.slice(-16)}</span>
        <span style={{ color: "#444", fontSize: 10 }}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <pre
          style={{
            fontSize: 10,
            padding: "8px",
            background: "#0d0d0d",
            color: "#c0c0c0",
            overflowX: "auto",
            maxHeight: 240,
            overflowY: "auto",
            borderTop: `1px solid #222`,
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          {pretty}
        </pre>
      )}
    </div>
  );
}

function DisputePackView({ proxyBUrl, resetToken }: { proxyBUrl: string; resetToken: number }) {
  const envB = useEnvelopes(proxyBUrl, resetToken);
  const traceIds = useMemo(
    () => [...new Set(envB.map((e) => e.trace_id))],
    [envB]
  );
  const [selectedTrace, setSelectedTrace] = useState("");
  const [pack, setPack] = useState<DisputePack | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSelectedTrace("");
    setPack(null);
  }, [resetToken]);

  const fetchPack = async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      const r = await fetch(`${proxyBUrl}/dispute/${encodeURIComponent(id)}`);
      setPack(await r.json());
    } finally {
      setLoading(false);
    }
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
          onChange={(e) => {
            setSelectedTrace(e.target.value);
            setPack(null);
          }}
          style={{
            flex: 1,
            background: "#111",
            color: "#ccc",
            border: "1px solid #333",
            borderRadius: 3,
            padding: "3px 6px",
            fontFamily: "inherit",
            fontSize: 11,
          }}
        >
          <option value="">Select trace ID…</option>
          {traceIds.map((id) => (
            <option key={id} value={id}>…{id.slice(-24)}</option>
          ))}
        </select>
        <button
          onClick={() => fetchPack(selectedTrace)}
          disabled={!selectedTrace || loading}
          style={{
            padding: "3px 8px",
            background: "#1a2a3a",
            border: "1px solid #7bb3ff",
            borderRadius: 3,
            color: "#7bb3ff",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 11,
          }}
        >
          Load
        </button>
        <button
          onClick={flushAndFetch}
          disabled={!selectedTrace || loading}
          style={{
            padding: "3px 8px",
            background: "#1a1a2a",
            border: "1px solid #a78bfa",
            borderRadius: 3,
            color: "#a78bfa",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 11,
          }}
          title="Flush Merkle batch then load dispute pack"
        >
          Flush + Load
        </button>
      </div>
      {!selectedTrace && (
        <div style={{ color: "#444", fontSize: 11 }}>Select a trace ID to view its Dispute Pack.</div>
      )}
      {loading && <div style={{ color: "#666", fontSize: 11 }}>Loading…</div>}
      {pack && (
        <pre
          style={{
            flex: 1,
            fontSize: 10,
            background: "#0d0d0d",
            color: "#c0c0c0",
            padding: 8,
            borderRadius: 4,
            border: "1px solid #222",
            overflowY: "auto",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {JSON.stringify(pack, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function DisputeConsole({ resetToken = 0 }: { resetToken?: number }) {
  const [tab, setTab] = useState<"envelopes" | "dispute">("envelopes");
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
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #222",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            color: "#7bb3ff",
            fontWeight: "bold",
            fontSize: 12,
            letterSpacing: 1,
            textTransform: "uppercase",
            marginRight: 4,
          }}
        >
          Dispute Console
        </span>
        {tabBtn("Envelopes", tab === "envelopes", () => setTab("envelopes"))}
        {tabBtn("Dispute Pack", tab === "dispute", () => setTab("dispute"))}
      </div>

      {tab === "envelopes" && (
        <>
          <div style={{ padding: "6px 10px", borderBottom: "1px solid #1a1a1a", display: "flex", gap: 6 }}>
            {tabBtn("Bank-A", nodeTab === "bank-a", () => setNodeTab("bank-a"))}
            {tabBtn("Bank-B", nodeTab === "bank-b", () => setNodeTab("bank-b"))}
            <span style={{ color: "#444", fontSize: 10, alignSelf: "center", marginLeft: "auto" }}>
              {envelopes.length} records
            </span>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px" }}>
            {envelopes.length === 0 && (
              <div style={{ color: "#444", fontSize: 11 }}>No envelopes yet.</div>
            )}
            {envelopes.map((env) => (
              <EnvelopeRow key={env.id} env={env} />
            ))}
          </div>
        </>
      )}

      {tab === "dispute" && (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <DisputePackView proxyBUrl={PROXY_B} resetToken={resetToken} />
        </div>
      )}
    </div>
  );
}
