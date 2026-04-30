export interface ThoughtEvent {
  source: "bank-a" | "bank-b";
  text: string;
  ts: string;
}

export interface HandshakeEvent {
  traceId?: string | null;
  tool?: string;
  cost?: number;
  status?: string;
  errorCode?: number;
  reason?: string;
  ts: string;
}

export interface Envelope {
  id: string;
  type: string;
  trace_id: string;
  raw_payload: string;
  signature: string;
  created_at: string;
}

export interface DisputePack {
  records: unknown[];
  entries: unknown[];
  inclusionProofs: unknown[];
}
