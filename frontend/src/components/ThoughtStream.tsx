import { useRef, useEffect, useMemo, useState } from "react";
import { useSSEMulti } from "../hooks/useSSEMulti";
import type { ThoughtEvent } from "../types";

const PROXY_A = import.meta.env.VITE_PROXY_A_URL ?? "http://localhost:3001";
const PROXY_B = import.meta.env.VITE_PROXY_B_URL ?? "http://localhost:3002";

const BANK_A_COLOR = "#4caf50";
const BANK_B_COLOR = "#ff9800";

const PROTOCOL_EVENT_COLOR: Record<string, string> = {
  INTENT: "#7bb3ff",
  ACCEPTANCE: "#4caf50",
  EXECUTION: "#a78bfa",
  PROVENANCE: "#f0a500",
  "intent-accepted": "#4caf50",
  "intent-rejected": "#f44336",
  "execution-complete": "#a78bfa",
};

type Mode = "thoughts" | "protocol";

export function ThoughtStream({ resetToken = 0 }: { resetToken?: number }) {
  const [mode, setMode] = useState<Mode>("thoughts");

  const rawA = useSSEMulti(`${PROXY_A}/events`, ["thought", "envelope", "execution-complete"] as const, resetToken);
  const rawB = useSSEMulti(`${PROXY_B}/events`, ["thought", "intent-accepted", "intent-rejected", "execution-complete"] as const, resetToken);

  const thoughtsA = rawA["thought"] ?? [];
  const thoughtsB = rawB["thought"] ?? [];
  const envelopeA = rawA["envelope"] ?? [];
  const execA     = rawA["execution-complete"] ?? [];
  const acceptedB = rawB["intent-accepted"] ?? [];
  const rejectedB = rawB["intent-rejected"] ?? [];
  const execB     = rawB["execution-complete"] ?? [];

  const thoughts = useMemo(() => {
    const a = thoughtsA.map((d) => { try { return JSON.parse(d) as ThoughtEvent; } catch { return null; } }).filter(Boolean) as ThoughtEvent[];
    const b = thoughtsB.map((d) => { try { return JSON.parse(d) as ThoughtEvent; } catch { return null; } }).filter(Boolean) as ThoughtEvent[];
    return [...a, ...b].sort((x, y) => x.ts.localeCompare(y.ts));
  }, [thoughtsA, thoughtsB]);

  const protocolLog = useMemo(() => {
    type LogEntry = { ts: string; color: string; label: string; detail: string };
    const entries: LogEntry[] = [];

    const parse = (raw: string): any => { try { return JSON.parse(raw); } catch { return {}; } };

    for (const d of envelopeA) {
      const e = parse(d);
      if (!e.type) continue;
      entries.push({
        ts: e.ts ?? "",
        color: PROTOCOL_EVENT_COLOR[e.type] ?? "#888",
        label: `A→B  [${e.type}]`,
        detail: [e.tool && `tool:${e.tool}`, e.traceId && `trace:…${String(e.traceId).slice(-8)}`].filter(Boolean).join("  "),
      });
    }
    for (const d of execA) {
      const e = parse(d);
      entries.push({
        ts: e.ts ?? "",
        color: "#a78bfa",
        label: `A    [EXEC]`,
        detail: [`status:${e.status ?? "?"}`, e.traceId && `trace:…${String(e.traceId).slice(-8)}`].filter(Boolean).join("  "),
      });
    }
    for (const d of acceptedB) {
      const e = parse(d);
      entries.push({
        ts: e.ts ?? "",
        color: "#4caf50",
        label: `B    [ACCEPTED]`,
        detail: [e.tool && `tool:${e.tool}`, e.traceId && `trace:…${String(e.traceId).slice(-8)}`].filter(Boolean).join("  "),
      });
    }
    for (const d of rejectedB) {
      const e = parse(d);
      entries.push({
        ts: e.ts ?? "",
        color: "#f44336",
        label: `B    [REJECTED]`,
        detail: [`code:${e.errorCode ?? "?"}`, e.traceId && `trace:…${String(e.traceId).slice(-8)}`].filter(Boolean).join("  "),
      });
    }
    for (const d of execB) {
      const e = parse(d);
      entries.push({
        ts: e.ts ?? "",
        color: "#a78bfa",
        label: `B    [EXEC]`,
        detail: [`status:${e.status ?? "?"}`, e.traceId && `trace:…${String(e.traceId).slice(-8)}`].filter(Boolean).join("  "),
      });
    }

    return entries.sort((a, b) => a.ts.localeCompare(b.ts));
  }, [envelopeA, execA, acceptedB, rejectedB, execB]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const listLen = mode === "thoughts" ? thoughts.length : protocolLog.length;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [listLen]);

  const tabBtn = (label: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        padding: "2px 8px", background: active ? "#1a2a1a" : "transparent",
        border: `1px solid ${active ? "#4caf50" : "#2a2a2a"}`,
        borderRadius: 2, color: active ? "#4caf50" : "#444",
        cursor: "pointer", fontFamily: "inherit", fontSize: 9,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{
        padding: "10px 12px", borderBottom: "1px solid #222",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        minHeight: 84, boxSizing: "border-box", gap: 8, flexWrap: "wrap",
      }}>
        <span style={{
          color: "#7bb3ff", fontWeight: "bold", fontSize: 12,
          letterSpacing: 1, textTransform: "uppercase",
        }}>
          Agent Thought Stream
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {tabBtn("Thoughts", mode === "thoughts", () => setMode("thoughts"))}
          {tabBtn("Protocol", mode === "protocol", () => setMode("protocol"))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
        {/* ── Thoughts mode ── */}
        {mode === "thoughts" && (
          <>
            {thoughts.length === 0 && (
              <div style={{ color: "#2a2a3a", fontSize: 12, marginTop: 12 }}>
                Waiting for demo to start…
              </div>
            )}
            {thoughts.map((t, i) => {
              const color = t.source === "bank-a" ? BANK_A_COLOR : BANK_B_COLOR;
              const label = t.source === "bank-a" ? "BANK-A" : "BANK-B";
              return (
                <div key={i} style={{
                  marginBottom: 6, padding: "6px 10px",
                  background: "#111", borderRadius: 4, borderLeft: `3px solid ${color}`,
                }}>
                  <div style={{ color, fontSize: 10, marginBottom: 3 }}>
                    {label} · {new Date(t.ts).toLocaleTimeString()}
                  </div>
                  <div style={{ lineHeight: 1.4 }}>{t.text}</div>
                </div>
              );
            })}
          </>
        )}

        {/* ── Protocol mode ── */}
        {mode === "protocol" && (
          <>
            {protocolLog.length === 0 && (
              <div style={{ color: "#2a2a3a", fontSize: 10, marginTop: 12, fontFamily: "monospace" }}>
                $ awaiting A2A protocol traffic…
              </div>
            )}
            {protocolLog.map((entry, i) => (
              <div key={i} style={{
                marginBottom: 3, fontFamily: "monospace", fontSize: 9,
                lineHeight: 1.6, borderLeft: `2px solid ${entry.color}55`,
                paddingLeft: 8, paddingTop: 1, paddingBottom: 1,
              }}>
                <span style={{ color: "#333" }}>{new Date(entry.ts).toLocaleTimeString()} </span>
                <span style={{ color: entry.color, fontWeight: "bold" }}>{entry.label}</span>
                {entry.detail && (
                  <div style={{ color: "#444", paddingLeft: 8, fontSize: 8 }}>{entry.detail}</div>
                )}
              </div>
            ))}
          </>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
