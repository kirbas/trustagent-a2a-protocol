/**
 * TrustAgentAI — Merkle DAG Ledger + Timestamp Registry
 *
 * Implements D5: Tamper-evident history via Merkle-batching.
 *
 * Architecture:
 *  - Each LedgerEntry has an entry_hash = SHA256(JCS(entry WITHOUT entry_hash))
 *  - Entries reference prev_entry_hashes → forms a DAG
 *  - Every BATCH_SIZE entries (or on flush()), a Merkle root is computed
 *  - The root is "anchored" externally (L2 txHash placeholder)
 *  - TimestampRegistry stores entry metadata for fast lookup by trace_id
 */
import { IntentEnvelope, AcceptanceReceipt, ExecutionEnvelope } from "./envelopes.js";
export type EventType = "INTENT_RECORD" | "ACCEPTANCE_RECORD" | "EXECUTION_RECORD" | "ACK_RECORD";
export type ArtifactEnvelope = IntentEnvelope | AcceptanceReceipt | ExecutionEnvelope;
export interface LedgerEntry {
    entry_id: number;
    trace_id: string;
    event_type: EventType;
    prev_entry_hashes: string[];
    artifact: ArtifactEnvelope;
    entry_hash: string;
    batch_id?: number;
}
export interface MerkleBatch {
    batch_id: number;
    entry_hashes: string[];
    merkle_root: string;
    anchored_at?: string;
    created_at: string;
}
export interface TimestampRecord {
    trace_id: string;
    event_type: EventType;
    entry_id: number;
    entry_hash: string;
    timestamp: string;
    batch_id?: number;
}
/**
 * Builds a binary Merkle tree and returns the root hash.
 * Leaves are the raw hex entry_hashes.
 * If odd number of leaves, the last leaf is duplicated (standard Bitcoin-style).
 */
export declare function computeMerkleRoot(leaves: string[]): string;
/**
 * Returns the Merkle inclusion proof (path) for a leaf at `index`.
 * Each step is { sibling: string, position: "left" | "right" }.
 */
export declare function getMerkleProof(leaves: string[], index: number): Array<{
    sibling: string;
    position: "left" | "right";
}>;
/**
 * Verify a Merkle proof against a known root.
 */
export declare function verifyMerkleProof(leafHash: string, proof: Array<{
    sibling: string;
    position: "left" | "right";
}>, root: string): boolean;
export declare class DAGLedger {
    private entries;
    private batches;
    private pendingBatchEntries;
    private nextEntryId;
    private nextBatchId;
    private readonly batchSize;
    private registry;
    constructor(batchSize?: number);
    append(event_type: EventType, artifact: ArtifactEnvelope, prevEntryHashes?: string[]): LedgerEntry;
    flush(): MerkleBatch | null;
    private _commitBatch;
    anchorBatch(batchId: number, l2TxHash: string): void;
    getDisputePack(traceId: string): {
        records: TimestampRecord[];
        entries: LedgerEntry[];
        inclusionProofs: Array<{
            entry_hash: string;
            proof: ReturnType<typeof getMerkleProof>;
            batch: MerkleBatch;
        }>;
    };
    getHistory(traceId: string): TimestampRecord[];
    getAllEntries(): LedgerEntry[];
    getBatches(): MerkleBatch[];
}
//# sourceMappingURL=ledger.d.ts.map