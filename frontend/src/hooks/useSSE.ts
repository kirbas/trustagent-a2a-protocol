import { useState, useEffect } from "react";

export function useSSE(url: string, eventName: string, resetToken = 0): string[] {
  const [events, setEvents] = useState<string[]>([]);

  useEffect(() => {
    setEvents([]);
    const es = new EventSource(url);
    const handler = (e: MessageEvent) => {
      setEvents((prev) => [...prev, e.data]);
    };
    es.addEventListener(eventName, handler);
    return () => {
      es.removeEventListener(eventName, handler);
      es.close();
    };
  }, [url, eventName, resetToken]);

  return events;
}
