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
import { sha256Json } from "./crypto.js";
// ─── Merkle Tree ──────────────────────────────────────────────────────────────
/**
 * Builds a binary Merkle tree and returns the root hash.
 * Leaves are the raw hex entry_hashes.
 * If odd number of leaves, the last leaf is duplicated (standard Bitcoin-style).
 */
export function computeMerkleRoot(leaves) {
    if (leaves.length === 0)
        throw new Error("Cannot compute Merkle root of empty set");
    let level = [...leaves];
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last
            next.push(sha256Json({ left, right }));
        }
        level = next;
    }
    return level[0];
}
/**
 * Returns the Merkle inclusion proof (path) for a leaf at `index`.
 * Each step is { sibling: string, position: "left" | "right" }.
 */
export function getMerkleProof(leaves, index) {
    const proof = [];
    let level = [...leaves];
    let idx = index;
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = i + 1 < level.length ? level[i + 1] : level[i];
            next.push(sha256Json({ left, right }));
            // Collect sibling for our index
            if (i === idx || i + 1 === idx) {
                if (i === idx) {
                    proof.push({ sibling: right, position: "right" });
                }
                else {
                    proof.push({ sibling: left, position: "left" });
                }
            }
        }
        idx = Math.floor(idx / 2);
        level = next;
    }
    return proof;
}
/**
 * Verify a Merkle proof against a known root.
 */
export function verifyMerkleProof(leafHash, proof, root) {
    let current = leafHash;
    for (const step of proof) {
        const left = step.position === "right" ? current : step.sibling;
        const right = step.position === "right" ? step.sibling : current;
        current = sha256Json({ left, right });
    }
    return current === root;
}
// ─── DAG Ledger ───────────────────────────────────────────────────────────────
const DEFAULT_BATCH_SIZE = 8;
export class DAGLedger {
    entries = [];
    batches = [];
    pendingBatchEntries = []; // entry_hashes waiting for batch
    nextEntryId = 1;
    nextBatchId = 1;
    batchSize;
    // TimestampRegistry: fast lookup by trace_id
    registry = new Map();
    constructor(batchSize = DEFAULT_BATCH_SIZE) {
        this.batchSize = batchSize;
    }
    // ── Append ─────────────────────────────────────────────────────────────────
    append(event_type, artifact, prevEntryHashes = []) {
        const entryWithoutHash = {
            entry_id: this.nextEntryId,
            trace_id: artifact.trace_id,
            event_type,
            prev_entry_hashes: prevEntryHashes,
            artifact,
        };
        const entry_hash = sha256Json(entryWithoutHash);
        const entry = { ...entryWithoutHash, entry_hash };
        this.entries.push(entry);
        // Register in TimestampRegistry
        const timestamp = "timestamp" in artifact ? artifact.timestamp : new Date().toISOString();
        const record = {
            trace_id: artifact.trace_id,
            event_type,
            entry_id: entry.entry_id,
            entry_hash,
            timestamp,
        };
        const existing = this.registry.get(artifact.trace_id) ?? [];
        existing.push(record);
        this.registry.set(artifact.trace_id, existing);
        this.pendingBatchEntries.push(entry_hash);
        this.nextEntryId++;
        // Auto-batch when threshold is reached
        if (this.pendingBatchEntries.length >= this.batchSize) {
            this._commitBatch();
        }
        return entry;
    }
    // ── Manual flush ───────────────────────────────────────────────────────────
    flush() {
        if (this.pendingBatchEntries.length === 0)
            return null;
        return this._commitBatch();
    }
    _commitBatch() {
        const leaves = [...this.pendingBatchEntries];
        const merkle_root = computeMerkleRoot(leaves);
        const batchId = this.nextBatchId++;
        const batch = {
            batch_id: batchId,
            entry_hashes: leaves,
            merkle_root,
            created_at: new Date().toISOString(),
            // anchored_at: set externally after L2 submission
        };
        this.batches.push(batch);
        this.pendingBatchEntries = [];
        // Back-fill batch_id on entries
        for (const entry of this.entries) {
            if (leaves.includes(entry.entry_hash)) {
                entry.batch_id = batchId;
                const records = this.registry.get(entry.trace_id) ?? [];
                for (const r of records) {
                    if (r.entry_hash === entry.entry_hash)
                        r.batch_id = batchId;
                }
            }
        }
        return batch;
    }
    // ── Anchor (call after L2 submission) ─────────────────────────────────────
    anchorBatch(batchId, l2TxHash) {
        const batch = this.batches.find((b) => b.batch_id === batchId);
        if (!batch)
            throw new Error(`Batch ${batchId} not found`);
        batch.anchored_at = l2TxHash;
    }
    // ── Dispute Pack ───────────────────────────────────────────────────────────
    getDisputePack(traceId) {
        const records = this.registry.get(traceId) ?? [];
        const entries = this.entries.filter((e) => e.trace_id === traceId);
        const inclusionProofs = [];
        for (const entry of entries) {
            if (entry.batch_id == null)
                continue;
            const batch = this.batches.find((b) => b.batch_id === entry.batch_id);
            if (!batch)
                continue;
            const leafIdx = batch.entry_hashes.indexOf(entry.entry_hash);
            if (leafIdx === -1)
                continue;
            const proof = getMerkleProof(batch.entry_hashes, leafIdx);
            inclusionProofs.push({ entry_hash: entry.entry_hash, proof, batch });
        }
        return { records, entries, inclusionProofs };
    }
    // ── Timestamp Registry lookup ──────────────────────────────────────────────
    getHistory(traceId) {
        return this.registry.get(traceId) ?? [];
    }
    getAllEntries() {
        return [...this.entries];
    }
    getBatches() {
        return [...this.batches];
    }
}
//# sourceMappingURL=ledger.js.map