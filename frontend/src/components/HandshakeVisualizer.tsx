import { useMemo, useState, useEffect } from "react";
import { useSSE } from "../hooks/useSSE";
import type { HandshakeEvent, AnchorEvent } from "../types";

import { getProxyUrl } from "../utils/urls";

const PROXY_A = getProxyUrl(3001, import.meta.env.VITE_PROXY_A_URL);
const PROXY_B = getProxyUrl(3002, import.meta.env.VITE_PROXY_B_URL);

interface TraceStep {
  label: string;
  ok: boolean;
  basescanUrl?: string;
  pending?: boolean;
}

interface Trace {
  traceId: string;
  tool: string;
  cost: number;
  steps: TraceStep[];
}

function parseAll(raws: string[]): HandshakeEvent[] {
  return raws.map((d) => {
    try { return JSON.parse(d) as HandshakeEvent; }
    catch { return { ts: "" }; }
  });
}

function parseAnchors(raws: string[]): AnchorEvent[] {
  return raws.flatMap((d) => {
    try { return [JSON.parse(d) as AnchorEvent]; }
    catch { return []; }
  });
}

const stripId = (id: string | null | undefined) => id ? id.replace(/^urn:uuid:/, "") : "";

export function HandshakeVisualizer({
  resetToken = 0,
  onReset,
}: {
  resetToken?: number;
  onReset: () => void;
}) {
  const [running, setRunning] = useState(false);
  const { eventsA, eventsB } = useSSE();

  const demoRaw          = eventsA["demo-triggered"]    ?? [];
  const execARaw         = eventsA["execution-complete"] ?? [];
  const envelopeARaw     = eventsA["envelope"]           ?? [];
  const acceptedRaw      = eventsB["intent-accepted"]    ?? [];
  const rejectedRaw      = eventsB["intent-rejected"]    ?? [];
  const anchorPendingRaw = eventsB["anchor-pending"]     ?? [];
  const anchorCompleteRaw = eventsB["anchor-complete"]    ?? [];
  const anchorFailedRaw  = eventsB["anchor-failed"]      ?? [];

  useEffect(() => {
    if (demoRaw.length > 0) setRunning(true);
  }, [demoRaw.length]);

  const traces = useMemo<Trace[]>(() => {
    const map = new Map<string, Trace>();

    const addOrGet = (rawTraceId: string, tool?: string, cost?: number): Trace => {
      const traceId = stripId(rawTraceId);
      let t = map.get(traceId);
      if (!t) {
        t = { traceId, tool: tool ?? "", cost: cost ?? 0, steps: [] };
        map.set(traceId, t);
      } else {
        if (!t.tool && tool) t.tool = tool;
        if (!t.cost && cost) t.cost = cost;
      }
      return t;
    };

    // 1. Process intents (Accepted or Rejected) from Bank-B SSE
    parseAll(acceptedRaw).forEach((e) => {
      if (!e.traceId) return;
      const t = addOrGet(e.traceId, e.tool, e.cost);
      t.steps.push({ label: "ACCEPTED (B) ✓", ok: true });
    });

    parseAll(rejectedRaw).forEach((e) => {
      if (!e.traceId) return;
      const t = addOrGet(e.traceId, e.tool, e.cost);
      t.steps.push({ label: `REJECTED (B) — ${e.reason || "ERR"}`, ok: false });
    });

    // 2. Process envelope events from Bank-A (INTENT, ACCEPTANCE, EXECUTION, PROVENANCE)
    parseAll(envelopeARaw).forEach((e: any) => {
      if (!e.traceId) return;
      const t = addOrGet(e.traceId, e.tool, e.cost);
      if (e.type === "INTENT") {
        t.steps.unshift({ label: "INTENT (A→B) ✓", ok: true });
      } else if (e.type === "ACCEPTANCE") {
        t.steps.push({ label: "ACCEPTANCE (A) ✓", ok: true });
      } else if (e.type === "PROVENANCE") {
        t.steps.push({ label: "PROVENANCE (A) ✓", ok: true });
      }
    });

    parseAll(execARaw).forEach((e) => {
      if (!e.traceId) return;
      const t = addOrGet(e.traceId);
      t.steps.push({ label: `EXECUTED (A) ${e.status === "SUCCESS" ? "✓" : "✗"}`, ok: e.status === "SUCCESS" });
    });

    // 4. Process Anchoring (Bank-B)
    parseAnchors(anchorPendingRaw).forEach((e) => {
      if (!e.traceId) return;
      const t = addOrGet(e.traceId);
      if (!t.steps.some(s => s.pending || s.basescanUrl)) {
        t.steps.push({ label: "ANCHORING (B) ⏳", ok: true, pending: true });
      }
    });

    parseAnchors(anchorCompleteRaw).forEach((e) => {
      if (!e.traceId) return;
      const t = addOrGet(e.traceId);
      t.steps = t.steps.filter(s => !s.pending && !s.label.startsWith("ANCHOR"));
      t.steps.push({
        label: `ANCHORED (B) ⛓ block ${e.blockNumber || ""}`,
        ok: true,
        basescanUrl: e.basescanUrl
      });
    });

    parseAnchors(anchorFailedRaw).forEach((e: any) => {
      if (!e.traceId) return;
      const t = addOrGet(e.traceId);
      t.steps = t.steps.filter(s => !s.pending);
      t.steps.push({ label: "ANCHOR FAILED (B) ✗", ok: false });
    });

    return Array.from(map.values()).sort((a, b) => a.traceId.localeCompare(b.traceId));
  }, [acceptedRaw, rejectedRaw, envelopeARaw, execARaw, anchorPendingRaw, anchorCompleteRaw, anchorFailedRaw]);

  const demoComplete = traces.length >= 2;

  const trigger = () => {
    fetch(`${PROXY_A}/trigger`, { method: "POST" });
    setRunning(true);
  };

  const reset = async () => {
    await Promise.all([
      fetch(`${PROXY_A}/reset`, { method: "POST" }),
      fetch(`${PROXY_B}/reset`, { method: "POST" }),
    ]);
    setRunning(false);
    onReset();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: "10px 12px",
          background: "#08080a",
          borderBottom: "1px solid #1a1a2a",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: "bold", letterSpacing: 1, color: "#aaa" }}>
            BILATERAL HANDSHAKE
          </span>
          {!running && traces.length === 0 && (
            <button 
              onClick={trigger}
              style={{
                background: "#4caf50", border: "none", color: "#000",
                fontSize: 9, fontWeight: "bold", padding: "2px 6px",
                borderRadius: 2, cursor: "pointer"
              }}
            >
              🚀 START DEMO
            </button>
          )}
          <div style={{ display: "flex", gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: running ? "#4caf50" : "#333" }} />
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: demoComplete ? "#4caf50" : "#333" }} />
          </div>
        </div>
        <button
          onClick={reset}
          style={{
            background: "#1a1a2a",
            border: "1px solid #333",
            color: "#7bb3ff",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 10,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          ↺ Clear messages and restart demo
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px", position: "relative" }}>
        {traces.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 20,
            }}
          >
            <div style={{ fontSize: 40, filter: "grayscale(1) opacity(0.3)" }}>🤝</div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
               <div style={{ fontSize: 11, color: "#444", textAlign: "center" }}>
                 System idle. Waiting for autonomous scenario trigger.
               </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {traces.map((trace) => (
              <div
                key={trace.traceId}
                style={{
                  background: "#0d0d0f",
                  border: "1px solid #222",
                  borderRadius: 6,
                  padding: "12px",
                  borderLeft: `3px solid ${trace.steps.some((s) => !s.ok) ? "#f44336" : "#4caf50"}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ color: "#eee", fontSize: 12, fontWeight: "bold", fontFamily: "monospace" }}>
                      {trace.tool || "—"} <span style={{ color: "#444", fontWeight: "normal" }}>·</span> <span style={{ color: "#4caf50" }}>${trace.cost.toLocaleString()}</span> <span style={{ color: "#444", fontWeight: "normal" }}>·</span> <span style={{ color: "#444", fontSize: 10 }}>trace:...{trace.traceId.slice(-12)}</span>
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {trace.steps.map((step, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: "4px 8px",
                        background: step.pending ? "#1a1a00" : step.ok ? "#0a1a0a" : "#1a0a0a",
                        border: `1px solid ${step.pending ? "#a5a500" : step.ok ? "#2d5a2d" : "#5a2d2d"}`,
                        borderRadius: 4,
                        fontSize: 10,
                        color: step.pending ? "#f0a500" : step.ok ? "#4caf50" : "#f44336",
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      {step.label}
                      {step.basescanUrl && (
                        <a
                          href={step.basescanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            marginLeft: 4,
                            color: "#f0a500",
                            textDecoration: "none",
                            fontSize: 14,
                          }}
                          onClick={(e) => e.stopPropagation()}
                          title="View on Block Explorer"
                        >
                          ↗
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
