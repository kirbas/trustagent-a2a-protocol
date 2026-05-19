/// <reference types="vite/client" />
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { getProxyUrl } from "../utils/urls";

type Status = "connecting" | "connected" | "error";
type SystemPhase = "IDLE" | "RUNNING";

interface SSEContextType {
  eventsA: Record<string, string[]>;
  eventsB: Record<string, string[]>;
  statusA: Status;
  statusB: Status;
  health: Record<string, Status>;
  systemPhase: SystemPhase;
}

const SSEContext = createContext<SSEContextType | null>(null);

const PROXY_A = getProxyUrl(3001, import.meta.env.VITE_PROXY_A_URL);
const PROXY_B = getProxyUrl(3002, import.meta.env.VITE_PROXY_B_URL);
const AGENT_A = getProxyUrl(4001);
const AGENT_B = getProxyUrl(4002);
const ANCHOR  = getProxyUrl(5001);

const BASESCAN_TX_URL = "https://sepolia.basescan.org/tx/";

// Defensive JSON parser
const safeParse = (raw: string): any => {
  try { return JSON.parse(raw); } catch { return {}; }
};

// Trace ID normalizer (ensures URN/UUID consistency)
const normalizeTraceId = (tid: string | undefined): string => {
  if (!tid) return "";
  if (tid.startsWith("urn:uuid:")) return tid;
  if (tid.startsWith("uuid:")) return tid.replace("uuid:", "urn:uuid:");
  return `urn:uuid:${tid}`;
};

export function SSEProvider({ children, resetToken = 0 }: { children: React.ReactNode; resetToken?: number }) {
  const [eventsA, setEventsA] = useState<Record<string, string[]>>({});
  const [eventsB, setEventsB] = useState<Record<string, string[]>>({});
  const [statusA, setStatusA] = useState<Status>("connecting");
  const [statusB, setStatusB] = useState<Status>("connecting");
  const [health, setHealth] = useState<Record<string, Status>>({
    "Bank-A Proxy": "connecting",
    "Bank-B Proxy": "connecting",
    "Bank-A Agent": "connecting",
    "Bank-B Agent": "connecting",
    "Bank-B Anchor": "connecting",
  });
  const [systemPhase, setSystemPhase] = useState<SystemPhase>("IDLE");

  const pushEvent = useCallback((set: React.Dispatch<React.SetStateAction<Record<string, string[]>>>, name: string, data: string) => {
    set(prev => ({ ...prev, [name]: [...(prev[name] ?? []), data] }));
  }, []);

  useEffect(() => {
    setEventsA({});
    setEventsB({});
    setStatusA("connecting");
    setStatusB("connecting");
    setSystemPhase("IDLE");

    const pollHealth = async () => {
      const check = async (url: string) => {
        try {
          const r = await fetch(`${url}/health`, { mode: 'cors' });
          return r.ok ? "connected" : "error";
        } catch { return "error"; }
      };

      const [hA, hB, hAgA, hAgB, hAnc] = await Promise.all([
        check(PROXY_A), check(PROXY_B), check(AGENT_A), check(AGENT_B), check(ANCHOR),
      ]);

      setHealth({
        "Bank-A Proxy": hA as Status, "Bank-B Proxy": hB as Status,
        "Bank-A Agent": hAgA as Status, "Bank-B Agent": hAgB as Status,
        "Bank-B Anchor": hAnc as Status,
      });
      setStatusA(hA as Status);
      setStatusB(hB as Status);
    };

    const timer = setInterval(pollHealth, 5000);
    pollHealth();

    const fetchHistory = async () => {
      try {
        const [thoughtsA, envelopesA, thoughtsB, envelopesB, anchorsB] = await Promise.all([
          fetch(`${PROXY_A}/thoughts`).then(r => r.json()).catch(() => []),
          fetch(`${PROXY_A}/envelopes`).then(r => r.json()).catch(() => []),
          fetch(`${PROXY_B}/thoughts`).then(r => r.json()).catch(() => []),
          fetch(`${PROXY_B}/envelopes`).then(r => r.json()).catch(() => []),
          fetch(`${PROXY_B}/anchors`).then(r => r.json()).catch(() => []),
        ]);

        const mappedA: Record<string, string[]> = {
          thought: thoughtsA.map((t: any) => JSON.stringify({ source: t.source, text: t.text, ts: t.created_at })),
          envelope: envelopesA.filter((e: any) => e.type !== "EXECUTION").map((e: any) => {
            const payload = safeParse(e.raw_payload);
            return JSON.stringify({ 
              type: e.type, 
              traceId: normalizeTraceId(e.trace_id), 
              tool: payload.target?.tool_name || payload.params?.name || payload.tool_name,
              cost: payload.params?._estimated_cost_usd || payload._estimated_cost_usd,
              ts: e.created_at 
            });
          }),
          "execution-complete": envelopesA.filter((e: any) => e.type === "EXECUTION").map((e: any) => {
            const payload = safeParse(e.raw_payload);
            return JSON.stringify({
              traceId: normalizeTraceId(e.trace_id),
              status: payload.status,
              ts: e.created_at
            });
          })
        };

        const mappedB: Record<string, string[]> = {
          thought: thoughtsB.map((t: any) => JSON.stringify({ source: t.source, text: t.text, ts: t.created_at })),
          "intent-accepted": envelopesB.filter((e: any) => e.type === "ACCEPTANCE").map((e: any) => {
             return JSON.stringify({ traceId: normalizeTraceId(e.trace_id), ts: e.created_at });
          }),
          "intent-rejected": envelopesB.filter((e: any) => e.type === "DENIED").map((e: any) => {
             const payload = safeParse(e.raw_payload);
             const intent = envelopesB.find((env: any) => env.trace_id === e.trace_id && env.type === "INTENT");
             const intentPayload = intent ? safeParse(intent.raw_payload) : {};
             return JSON.stringify({ 
               traceId: normalizeTraceId(e.trace_id), 
               reason: payload.error || (payload.content ? safeParse(payload.content).message : "Policy Rejection"),
               tool: intentPayload.params?.name || intentPayload.target?.tool_name,
               cost: intentPayload.params?._estimated_cost_usd,
               ts: e.created_at 
             });
          })
        };

        if (anchorsB && anchorsB.length > 0) {
          const anchorEvents: string[] = [];
          for (const a of anchorsB) {
            if (a.status !== "CONFIRMED") continue;
            try {
              const leavesResp = await fetch(`${PROXY_B}/verify/${a.tx_hash}`);
              if (leavesResp.ok) {
                const leafData = await leavesResp.json();
                const uniqueTraces = [...new Set(leafData.leaves.map((l: any) => normalizeTraceId(l.traceId)).filter(Boolean))];
                uniqueTraces.forEach(tid => {
                  const txHash = a.tx_hash.startsWith("0x") ? a.tx_hash : "0x" + a.tx_hash;
                  anchorEvents.push(JSON.stringify({
                    traceId: tid,
                    merkleRoot: a.merkle_root,
                    txHash: txHash,
                    blockNumber: a.block_number,
                    basescanUrl: BASESCAN_TX_URL + txHash,   // tx/ + 0xABC = correct
                    ts: a.created_at
                  }));
                });
              }
            } catch (err) { console.warn("Failed to fetch leaves for anchor hydration", err); }
          }
          mappedB["anchor-complete"] = anchorEvents;
        }

        setEventsA(mappedA);
        setEventsB(mappedB);
        
        if (envelopesA.length > 0) {
           setSystemPhase("RUNNING");
        }

      } catch (err) {
        console.warn("[sse] failed to fetch history", err);
      }
    };

    fetchHistory();

    const esA = new EventSource(`${PROXY_A}/events`);
    const esB = new EventSource(`${PROXY_B}/events`);

    const setup = (
      es: EventSource, 
      set: React.Dispatch<React.SetStateAction<Record<string, string[]>>>,
      label: string
    ) => {
      es.onopen = () => console.log(`[sse] connection opened: ${label}`);
      es.onerror = (e) => console.error(`[sse] connection error: ${label}`, e);

      const allEvents = [
        "thought", "envelope", "execution-complete", "demo-triggered", 
        "intent-accepted", "intent-rejected", "anchor-pending", 
        "anchor-complete", "anchor-failed", "system-phase"
      ];
      
      allEvents.forEach(name => {
        es.addEventListener(name, (e: MessageEvent) => {
          console.log(`[sse] event received: ${label} -> ${name}`);
          
          if (name === "system-phase") {
            const data = safeParse(e.data);
            if (data.phase === "RUNNING") setSystemPhase("RUNNING");
            return;
          }

          pushEvent(set, name, e.data);
          
          // Phase transition on INTENT envelope
          if (name === "envelope") {
            const data = safeParse(e.data);
            if (data.type === "INTENT") setSystemPhase("RUNNING");
          }
        });
      });
    };

    setup(esA, setEventsA, "Proxy A");
    setup(esB, setEventsB, "Proxy B");

    return () => {
      clearInterval(timer);
      esA.close();
      esB.close();
    };
  }, [resetToken, pushEvent]);

  return (
    <SSEContext.Provider value={{ eventsA, eventsB, statusA, statusB, health, systemPhase }}>
      {children}
    </SSEContext.Provider>
  );
}

export function useSSE() {
  const ctx = useContext(SSEContext);
  if (!ctx) throw new Error("useSSE must be used within SSEProvider");
  return ctx;
}
