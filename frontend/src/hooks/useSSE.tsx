/// <reference types="vite/client" />
import React, { createContext, useContext, useState, useEffect } from "react";
import { getProxyUrl } from "../utils/urls";

interface SSEContextType {
  eventsA: Record<string, string[]>;
  eventsB: Record<string, string[]>;
  statusA: "connecting" | "connected" | "error";
  statusB: "connecting" | "connected" | "error";
}

const SSEContext = createContext<SSEContextType | null>(null);

const PROXY_A = getProxyUrl(3001, import.meta.env.VITE_PROXY_A_URL);
const PROXY_B = getProxyUrl(3002, import.meta.env.VITE_PROXY_B_URL);
const BASESCAN_TX_URL = "https://sepolia.basescan.org/tx/";

export function SSEProvider({ children, resetToken = 0 }: { children: React.ReactNode; resetToken?: number }) {
  const [eventsA, setEventsA] = useState<Record<string, string[]>>({});
  const [eventsB, setEventsB] = useState<Record<string, string[]>>({});
  const [statusA, setStatusA] = useState<"connecting" | "connected" | "error">("connecting");
  const [statusB, setStatusB] = useState<"connecting" | "connected" | "error">("connecting");

  useEffect(() => {
    setEventsA({});
    setEventsB({});
    setStatusA("connecting");
    setStatusB("connecting");

    // Fetch history
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
            const payload = JSON.parse(e.raw_payload);
            return JSON.stringify({ 
              type: e.type, 
              traceId: e.trace_id, 
              tool: payload.target?.tool_name || payload.tool_name,
              ts: e.created_at 
            });
          }),
          "execution-complete": envelopesA.filter((e: any) => e.type === "EXECUTION").map((e: any) => {
            const payload = JSON.parse(e.raw_payload);
            return JSON.stringify({
              traceId: e.trace_id,
              status: payload.status,
              ts: e.created_at
            });
          })
        };

        const mappedB: Record<string, string[]> = {
          thought: thoughtsB.map((t: any) => JSON.stringify({ source: t.source, text: t.text, ts: t.created_at })),
          "intent-accepted": envelopesB.filter((e: any) => e.type === "ACCEPTANCE").map((e: any) => {
             const payload = JSON.parse(e.raw_payload);
             return JSON.stringify({ traceId: e.trace_id, ts: e.created_at });
          }),
          "intent-rejected": envelopesB.filter((e: any) => e.type === "DENIED").map((e: any) => {
             const payload = JSON.parse(e.raw_payload);
             return JSON.stringify({ traceId: e.trace_id, reason: payload.error, ts: e.created_at });
          })
        };

        // Deep mapping for anchors to traceIds
        if (anchorsB && anchorsB.length > 0) {
          const anchorEvents: string[] = [];
          for (const a of anchorsB) {
            if (a.status !== "CONFIRMED") continue;
            try {
              const leavesResp = await fetch(`${PROXY_B}/verify/${a.tx_hash}`);
              if (leavesResp.ok) {
                const leafData = await leavesResp.json();
                const uniqueTraces = [...new Set(leafData.leaves.map((l: any) => l.traceId).filter(Boolean))];
                uniqueTraces.forEach(tid => {
                  anchorEvents.push(JSON.stringify({
                    traceId: tid,
                    merkleRoot: a.merkle_root,
                    txHash: a.tx_hash,
                    blockNumber: a.block_number,
                    basescanUrl: BASESCAN_TX_URL + a.tx_hash,
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
           setEventsA(prev => ({ ...prev, "demo-triggered": [JSON.stringify({ ts: new Date().toISOString() })] }));
        }

      } catch (err) {
        console.warn("[sse] failed to fetch history", err);
      }
    };

    fetchHistory();

    console.log(`[sse] connecting to A: ${PROXY_A}/events`);
    console.log(`[sse] connecting to B: ${PROXY_B}/events`);

    const esA = new EventSource(`${PROXY_A}/events`);
    const esB = new EventSource(`${PROXY_B}/events`);

    const setup = (
      es: EventSource, 
      set: React.Dispatch<React.SetStateAction<Record<string, string[]>>>,
      setStatus: (s: "connecting" | "connected" | "error") => void,
      label: string
    ) => {
      es.onopen = () => {
        console.log(`[sse] connection opened: ${label}`);
        setStatus("connected");
      };
      es.onerror = (e) => {
        console.error(`[sse] connection error: ${label}`, e);
        setStatus("error");
      };

      const allEvents = [
        "thought", "envelope", "execution-complete", "demo-triggered", 
        "intent-accepted", "intent-rejected", "anchor-pending", 
        "anchor-complete", "anchor-failed"
      ];
      
      allEvents.forEach(name => {
        es.addEventListener(name, (e: MessageEvent) => {
          console.log(`[sse] event received: ${label} -> ${name}`);
          set(prev => ({
            ...prev,
            [name]: [...(prev[name] ?? []), e.data]
          }));
        });
      });
    };

    setup(esA, setEventsA, setStatusA, "Proxy A");
    setup(esB, setEventsB, setStatusB, "Proxy B");

    return () => {
      esA.close();
      esB.close();
    };
  }, [resetToken]);

  return (
    <SSEContext.Provider value={{ eventsA, eventsB, statusA, statusB }}>
      {children}
    </SSEContext.Provider>
  );
}

export function useSSE() {
  const ctx = useContext(SSEContext);
  if (!ctx) throw new Error("useSSE must be used within SSEProvider");
  return ctx;
}
