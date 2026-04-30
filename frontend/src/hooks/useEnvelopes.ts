import { useState, useEffect } from "react";
import type { Envelope } from "../types";

export function useEnvelopes(proxyUrl: string, resetToken = 0): Envelope[] {
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);

  useEffect(() => {
    setEnvelopes([]);
    const fetchEnvelopes = () =>
      fetch(`${proxyUrl}/envelopes`)
        .then((r) => r.json())
        .then(setEnvelopes)
        .catch(() => {});

    fetchEnvelopes();
    const id = setInterval(fetchEnvelopes, 3000);
    return () => clearInterval(id);
  }, [proxyUrl, resetToken]);

  return envelopes;
}
