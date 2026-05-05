import { useState, useEffect } from "react";

/**
 * Single EventSource per URL, multiple named event listeners.
 * Prevents browser HTTP/1.1 per-host connection limit (6 max) from
 * being exhausted when listening to many event types on the same URL.
 */
export function useSSEMulti(
  url: string,
  eventNames: readonly string[],
  resetToken = 0
): Record<string, string[]> {
  const [events, setEvents] = useState<Record<string, string[]>>({});
  const namesKey = [...eventNames].sort().join(",");

  useEffect(() => {
    setEvents({});
    const es = new EventSource(url);
    const handlers = new Map<string, (e: MessageEvent) => void>();

    for (const name of eventNames) {
      const handler = (e: MessageEvent) => {
        setEvents((prev) => ({
          ...prev,
          [name]: [...(prev[name] ?? []), e.data],
        }));
      };
      handlers.set(name, handler);
      es.addEventListener(name, handler);
    }

    return () => {
      handlers.forEach((handler, name) => es.removeEventListener(name, handler));
      es.close();
    };
    // namesKey captures eventNames content as stable dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, namesKey, resetToken]);

  return events;
}
