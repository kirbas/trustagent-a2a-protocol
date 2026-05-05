import { useRef, useEffect, useMemo } from "react";
import { useSSE } from "../hooks/useSSE";
import type { ThoughtEvent } from "../types";

const PROXY_A = import.meta.env.VITE_PROXY_A_URL ?? "http://localhost:3001";
const PROXY_B = import.meta.env.VITE_PROXY_B_URL ?? "http://localhost:3002";

const BANK_A_COLOR = "#4caf50";
const BANK_B_COLOR = "#ff9800";

export function ThoughtStream({ resetToken = 0 }: { resetToken?: number }) {
  const rawA = useSSE(`${PROXY_A}/events`, "thought", resetToken);
  const rawB = useSSE(`${PROXY_B}/events`, "thought", resetToken);

  const thoughts = useMemo(() => {
    const a = rawA.map((d) => JSON.parse(d) as ThoughtEvent);
    const b = rawB.map((d) => JSON.parse(d) as ThoughtEvent);
    return [...a, ...b].sort((x, y) => x.ts.localeCompare(y.ts));
  }, [rawA, rawB]);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thoughts.length]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #222",
          color: "#7bb3ff",
          fontWeight: "bold",
          fontSize: 12,
          letterSpacing: 1,
          textTransform: "uppercase",
          minHeight: 84,
          display: "flex",
          alignItems: "center",
          boxSizing: "border-box",
        }}
      >
        Agent Thought Stream
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
        {thoughts.length === 0 && (
          <div style={{ color: "#444", fontSize: 12, marginTop: 12 }}>
            Waiting for demo to start…
          </div>
        )}
        {thoughts.map((t, i) => {
          const color = t.source === "bank-a" ? BANK_A_COLOR : BANK_B_COLOR;
          const label = t.source === "bank-a" ? "BANK-A" : "BANK-B";
          return (
            <div
              key={i}
              style={{
                marginBottom: 6,
                padding: "6px 10px",
                background: "#111",
                borderRadius: 4,
                borderLeft: `3px solid ${color}`,
              }}
            >
              <div style={{ color, fontSize: 10, marginBottom: 3 }}>
                {label} · {new Date(t.ts).toLocaleTimeString()}
              </div>
              <div style={{ lineHeight: 1.4 }}>{t.text}</div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
