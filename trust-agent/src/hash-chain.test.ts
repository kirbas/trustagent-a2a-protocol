import { describe, it, expect } from "vitest";
import {
  GENESIS_PREV_HASH,
  computeRowHash,
  verifyChain,
  type ChainRow,
} from "./hash-chain.js";

function makeRow(seq: number, prevHash: string, overrides: Partial<ChainRow> = {}): ChainRow {
  return {
    seq,
    prev_hash: prevHash,
    id: `env-${seq}`,
    type: "INTENT",
    trace_id: `trace-${seq}`,
    raw_payload: `{"n":${seq}}`,
    signature: `sig-${seq}`,
    created_at: `2026-07-05T00:00:0${seq}.000Z`,
    ...overrides,
  };
}

/** Build a well-formed linked chain of `n` rows starting at seq 0. */
function buildChain(n: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < n; i++) {
    const row = makeRow(i, prev);
    rows.push(row);
    prev = computeRowHash(row);
  }
  return rows;
}

describe("computeRowHash", () => {
  it("is deterministic for identical input", () => {
    const row = makeRow(0, GENESIS_PREV_HASH);
    expect(computeRowHash(row)).toBe(computeRowHash({ ...row }));
  });

  it("changes when any committed field changes", () => {
    const row = makeRow(0, GENESIS_PREV_HASH);
    const base = computeRowHash(row);
    expect(computeRowHash({ ...row, raw_payload: '{"n":999}' })).not.toBe(base);
    expect(computeRowHash({ ...row, signature: "tampered" })).not.toBe(base);
    expect(computeRowHash({ ...row, seq: 1 })).not.toBe(base);
    expect(computeRowHash({ ...row, prev_hash: "f".repeat(64) })).not.toBe(base);
  });

  it("returns a 64-char hex digest", () => {
    expect(computeRowHash(makeRow(0, GENESIS_PREV_HASH))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyChain", () => {
  it("accepts an empty chain (vacuously valid)", () => {
    expect(verifyChain([]).valid).toBe(true);
  });

  it("accepts a well-formed linked chain", () => {
    const result = verifyChain(buildChain(5));
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects a first row whose prev_hash is not genesis", () => {
    const rows = buildChain(3);
    rows[0] = { ...rows[0], prev_hash: "a".repeat(64) };
    const result = verifyChain(rows);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/genesis/i);
  });

  it("rejects a seq gap between rows", () => {
    const rows = buildChain(4);
    // drop the row at seq 2 -> gap
    const withGap = [rows[0], rows[1], rows[3]];
    const result = verifyChain(withGap);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/seq/i);
  });

  it("rejects tampered row content (broken prev_hash link)", () => {
    const rows = buildChain(4);
    // mutate the payload of row 1 without recomputing downstream links
    rows[1] = { ...rows[1], raw_payload: '{"n":666}' };
    const result = verifyChain(rows);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/prev_hash|link/i);
  });

  it("rejects an out-of-order / non-monotonic seq", () => {
    const rows = buildChain(3);
    const reordered = [rows[0], rows[2], rows[1]];
    expect(verifyChain(reordered).valid).toBe(false);
  });
});
