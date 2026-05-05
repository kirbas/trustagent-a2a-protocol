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

export interface DisputeRecord {
  trace_id: string;
  event_type: string;
  entry_hash: string;
  timestamp: string;
}

export interface DisputeEntry {
  trace_id: string;
  event_type: string;
  artifact: Record<string, unknown>;
  entry_hash: string;
}

export interface InclusionProof {
  entry_hash: string;
  proof: Array<{ hash: string; position: string }>;
  batch: {
    batch_id: string;
    merkle_root: string;
    anchored_at: string;
    created_at: string;
  };
}

export interface DisputePack {
  records: DisputeRecord[];
  entries: DisputeEntry[];
  inclusionProofs: InclusionProof[];
}

export interface AnchorEvent {
  traceId: string;
  merkleRoot: string;
  txHash: string;
  blockNumber: number;
  basescanUrl: string;
  ts: string;
}
