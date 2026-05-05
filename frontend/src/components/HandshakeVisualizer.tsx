import { useMemo, useState, useEffect } from "react";
import { useSSEMulti } from "../hooks/useSSEMulti";
import type { HandshakeEvent, AnchorEvent } from "../types";

const PROXY_A = import.meta.env.VITE_PROXY_A_URL ?? "http://localhost:3001";
const PROXY_B = import.meta.env.VITE_PROXY_B_URL ?? "http://localhost:3002";

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

export function HandshakeVisualizer({
  resetToken = 0,
  onReset,
}: {
  resetToken?: number;
  onReset: () => void;
}) {
  const [running, setRunning] = useState(false);

  const proxyA = useSSEMulti(`${PROXY_A}/events`, [
    "demo-triggered", "execution-complete", "envelope",
  ] as const, resetToken);
  const proxyB = useSSEMulti(`${PROXY_B}/events`, [
    "execution-complete", "anchor-pending", "anchor-complete",
    "anchor-failed", "intent-accepted", "intent-rejected",
  ] as const, resetToken);

  const demoRaw          = proxyA["demo-triggered"]    ?? [];
  const execARaw         = proxyA["execution-complete"] ?? [];
  const envelopeARaw     = proxyA["envelope"]           ?? [];
  const execBRaw         = proxyB["execution-complete"] ?? [];
  const anchorPendingRaw = proxyB["anchor-pending"]     ?? [];
  const anchorCompleteRaw= proxyB["anchor-complete"]    ?? [];
  const anchorFailedRaw  = proxyB["anchor-failed"]      ?? [];
  const acceptedRaw      = proxyB["intent-accepted"]    ?? [];
  const rejectedRaw      = proxyB["intent-rejected"]    ?? [];

  useEffect(() => {
    if (demoRaw.length > 0) setRunning(true);
  }, [demoRaw.length]);

  const traces = useMemo<Trace[]>(() => {
    const map = new Map<string, Trace>();

    const addOrGet = (traceId: string, tool?: string, cost?: number): Trace => {
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

    // 3. Process executions (Bilateral)
    parseAll(execARaw).forEach((e) => {
      if (!e.traceId) return;
      const t = addOrGet(e.traceId, e.tool, e.cost);
      t.steps.push({ label: "EXECUTED (A) ✓", ok: e.status === "COMPLETED" });
    });

    parseAll(execBRaw).forEach((e) => {
      if (!e.traceId) return;
      const t = addOrGet(e.traceId);
      t.steps.push({ label: "EXECUTED (B) ✓", ok: e.status === "COMPLETED" });
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

    return Array.from(map.values());
  }, [acceptedRaw, rejectedRaw, execARaw, execBRaw, envelopeARaw, anchorPendingRaw, anchorCompleteRaw, anchorFailedRaw]);

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
          borderBottom: "1px solid #222",
          display: "flex",
          alignItems: "center",
          gap: 12,
          minHeight: 84,
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            color: "#7bb3ff",
            fontWeight: "bold",
            fontSize: 12,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          Bilateral Handshake
        </span>
        {!running && (
          <button
            onClick={trigger}
            style={{
              padding: "4px 14px",
              background: "#1a4a1a",
              border: "1px solid #4caf50",
              borderRadius: 4,
              color: "#4caf50",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          >
            ▶ Start Demo
          </button>
        )}
        {running && demoComplete && (
          <button
            onClick={reset}
            style={{
              padding: "4px 14px",
              background: "#1a1a3a",
              border: "1px solid #7bb3ff",
              borderRadius: 4,
              color: "#7bb3ff",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          >
            ↺ Clear messages and restart demo
          </button>
        )}
        {running && !demoComplete && traces.length === 0 && (
          <span style={{ color: "#555", fontSize: 11 }}>Waiting for agent…</span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
        {traces.map((trace) => {
          const isSuccess = trace.steps.some((s) => s.label.startsWith("EXECUTED"));
          const isDenied = trace.steps.some((s) => s.label.startsWith("REJECTED"));
          const isAnchored = trace.steps.some((s) => s.basescanUrl);
          const borderColor = isAnchored
            ? "#f0a500"
            : isSuccess
            ? "#4caf50"
            : isDenied
            ? "#f44336"
            : "#888";
          return (
            <div
              key={trace.traceId}
              style={{
                marginBottom: 12,
                background: "#111",
                borderRadius: 6,
                padding: "10px 12px",
                borderLeft: `3px solid ${borderColor}`,
              }}
            >
              <div style={{ fontSize: 10, color: "#666", marginBottom: 8 }}>
                <span style={{ color: "#aaa" }}>{trace.tool || "—"}</span>
                {" · "}
                <span style={{ color: trace.cost > 10000 ? "#f44336" : "#4caf50" }}>
                  ${(trace.cost ?? 0).toLocaleString()}
                </span>
                {" · "}
                trace:…{(trace.traceId || "").slice(-12)}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {trace.steps.map((step, i) =>
                  step.basescanUrl ? (
                    <a
                      key={i}
                      href={step.basescanUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        padding: "2px 8px",
                        borderRadius: 3,
                        fontSize: 10,
                        background: "#2b1f00",
                        color: "#f0a500",
                        border: "1px solid #f0a500",
                        textDecoration: "none",
                        cursor: "pointer",
                      }}
                    >
                      {step.label} ↗
                    </a>
                  ) : (
                    <span
                      key={i}
                      style={{
                        padding: "2px 8px",
                        borderRadius: 3,
                        fontSize: 10,
                        background: step.pending
                          ? "#1a1a00"
                          : step.ok
                          ? "#0d2b0d"
                          : "#2b0d0d",
                        color: step.pending
                          ? "#999900"
                          : step.ok
                          ? "#4caf50"
                          : "#f44336",
                        border: `1px solid ${
                          step.pending ? "#666600" : step.ok ? "#4caf50" : "#f44336"
                        }`,
                      }}
                    >
                      {step.label}
                    </span>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
