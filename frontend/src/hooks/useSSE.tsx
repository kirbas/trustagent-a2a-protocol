/// <reference types="vite/client" />
import React, { createContext, useContext, useState, useEffect } from "react";

interface SSEContextType {
  eventsA: Record<string, string[]>;
  eventsB: Record<string, string[]>;
}

const SSEContext = createContext<SSEContextType | null>(null);

const PROXY_A = import.meta.env.VITE_PROXY_A_URL ?? "http://localhost:3001";
const PROXY_B = import.meta.env.VITE_PROXY_B_URL ?? "http://localhost:3002";

export function SSEProvider({ children, resetToken = 0 }: { children: React.ReactNode; resetToken?: number }) {
  const [eventsA, setEventsA] = useState<Record<string, string[]>>({});
  const [eventsB, setEventsB] = useState<Record<string, string[]>>({});

  useEffect(() => {
    setEventsA({});
    setEventsB({});

    const esA = new EventSource(`${PROXY_A}/events`);
    const esB = new EventSource(`${PROXY_B}/events`);

    const setup = (es: EventSource, set: React.Dispatch<React.SetStateAction<Record<string, string[]>>>) => {
      const allEvents = ["thought", "envelope", "execution-complete", "demo-triggered", "intent-accepted", "intent-rejected", "anchor-pending", "anchor-complete", "anchor-failed"];
      allEvents.forEach(name => {
        es.addEventListener(name, (e: MessageEvent) => {
          set(prev => ({
            ...prev,
            [name]: [...(prev[name] ?? []), e.data]
          }));
        });
      });
    };

    setup(esA, setEventsA);
    setup(esB, setEventsB);

    return () => {
      esA.close();
      esB.close();
    };
  }, [resetToken]);

  return (
    <SSEContext.Provider value={{ eventsA, eventsB }}>
      {children}
    </SSEContext.Provider>
  );
}

export function useSSE() {
  const ctx = useContext(SSEContext);
  if (!ctx) throw new Error("useSSE must be used within SSEProvider");
  return ctx;
}
