/**
 * TrustAgentAI — Per-party append-only hash-chain
 *
 * Each proxy owns one SQLite database = one party. Every persisted envelope
 * row carries a monotonic `seq` and a `prev_hash` that links it to the prior
 * row's content hash, forming a tamper-evident chain. Deleting a row leaves a
 * `seq` gap; editing a row's content breaks the `prev_hash` link of its
 * successor. See Delta #2 in docs/execution_plan.md.
 */

import { sha256Json } from "./crypto.js";

/** prev_hash of the first row in a chain (no predecessor). */
export const GENESIS_PREV_HASH = "0".repeat(64);

/**
 * The committed fields of a chained envelope row. `prev_hash` and `seq` are
 * part of the hash so the position in the chain is itself bound.
 */
export interface ChainRow {
  seq: number;
  prev_hash: string;
  id: string;
  type: string;
  trace_id: string;
  raw_payload: string;
  signature: string;
  created_at: string;
}

export interface ChainVerifyResult {
  valid: boolean;
  error?: string;
}

/**
 * Deterministic content hash of a chained row (hex SHA-256 over the JCS
 * canonicalization of its committed fields). This value becomes the next
 * row's `prev_hash`.
 */
export function computeRowHash(row: ChainRow): string {
  return sha256Json({
    seq: row.seq,
    prev_hash: row.prev_hash,
    id: row.id,
    type: row.type,
    trace_id: row.trace_id,
    raw_payload: row.raw_payload,
    signature: row.signature,
    created_at: row.created_at,
  });
}

/**
 * Verify an ordered list of rows forms an unbroken chain:
 *  - `seq` starts at 0 and increments by exactly 1 (no gaps, no reorder);
 *  - the first row's `prev_hash` is the genesis value;
 *  - each row's `prev_hash` equals the recomputed hash of its predecessor.
 * An empty chain is vacuously valid.
 */
export function verifyChain(rows: readonly ChainRow[]): ChainVerifyResult {
  let expectedPrev = GENESIS_PREV_HASH;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row.seq !== i) {
      return { valid: false, error: `seq mismatch at index ${i}: expected ${i}, got ${row.seq}` };
    }
    if (row.prev_hash !== expectedPrev) {
      const reason = i === 0 ? "does not match genesis" : "broken prev_hash link";
      return { valid: false, error: `prev_hash ${reason} at seq ${row.seq}` };
    }

    expectedPrev = computeRowHash(row);
  }

  return { valid: true };
}
