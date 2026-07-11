import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  initDb,
  setSseBus,
  saveEnvelope,
  getChain,
  verifyEnvelopeChain,
  getEnvelopes,
  getEnvelopesByTraceId,
  getAnchorByTxHash,
  getAnchorByTraceId,
  getAnchorLeaves,
  getDisputePackByTraceId,
  getAnchors,
  clearEnvelopes,
  saveThought,
  getThoughts,
} from "./db.js";

function freshDbPath(): string {
  return join(tmpdir(), `bank-b-db-test-${randomUUID()}.db`);
}

/** Insert an envelope, an anchor batch, and one anchor_leaf row directly, bypassing saveEnvelope/db.ts writers. */
function seedAnchoredEnvelope(path: string, envelopeId: string, traceId: string, type = "INTENT") {
  const raw = new Database(path);
  const now = new Date().toISOString();
  raw
    .prepare(
      "INSERT INTO envelopes (id, type, trace_id, raw_payload, signature, created_at, seq, prev_hash) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"
    )
    .run(envelopeId, type, traceId, JSON.stringify({ trace_id: traceId }), "sig", now, "0".repeat(64));
  raw
    .prepare(
      "INSERT INTO anchors (batch_id, merkle_root, tx_hash, block_number, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run("batch-1", "deadbeef", "cafebabe", 42, "CONFIRMED", now);
  raw
    .prepare(
      "INSERT INTO anchor_leaves (batch_id, leaf_index, envelope_id, leaf_hash, proof_path) VALUES (?, ?, ?, ?, ?)"
    )
    .run("batch-1", 0, envelopeId, "leafhash", JSON.stringify([{ sibling: "x", position: "right" }]));
  raw.close();
}

beforeEach(() => {
  setSseBus(null);
});

describe("saveEnvelope / getChain / verifyEnvelopeChain", () => {
  it("chains envelopes with incrementing seq and stays valid", () => {
    initDb(freshDbPath());
    saveEnvelope("id-1", "INTENT", "trace-1", {}, "sig");
    saveEnvelope("id-2", "ACCEPTANCE", "trace-1", {}, "sig");
    expect(getChain().map((c) => c.seq)).toEqual([0, 1]);
    expect(verifyEnvelopeChain().valid).toBe(true);
  });

  it("is a no-op on a duplicate id", () => {
    initDb(freshDbPath());
    saveEnvelope("id-1", "INTENT", "trace-1", {}, "sig");
    saveEnvelope("id-1", "INTENT", "trace-1", { changed: true }, "sig");
    expect(getChain()).toHaveLength(1);
  });

  it("broadcasts envelope for every type and system-phase only for INTENT", () => {
    const bus = { broadcast: vi.fn() };
    setSseBus(bus);
    initDb(freshDbPath());

    saveEnvelope("id-1", "ACCEPTANCE", "trace-1", {}, "sig");
    expect(bus.broadcast).toHaveBeenCalledWith("envelope", expect.objectContaining({ type: "ACCEPTANCE" }));
    expect(bus.broadcast).not.toHaveBeenCalledWith("system-phase", expect.anything());

    saveEnvelope("id-2", "INTENT", "trace-1", {}, "sig");
    expect(bus.broadcast).toHaveBeenCalledWith("system-phase", { phase: "RUNNING" });
  });
});

describe("getEnvelopes / getEnvelopesByTraceId", () => {
  it("filters by trace_id", () => {
    initDb(freshDbPath());
    saveEnvelope("id-1", "INTENT", "trace-1", {}, "sig");
    saveEnvelope("id-2", "INTENT", "trace-2", {}, "sig");
    expect(getEnvelopes()).toHaveLength(2);
    expect(getEnvelopesByTraceId("trace-1")).toHaveLength(1);
  });
});

describe("anchor lookups", () => {
  it("getAnchorByTxHash finds the anchor and getAnchorByTraceId resolves via the envelope join", () => {
    const path = freshDbPath();
    initDb(path);
    seedAnchoredEnvelope(path, "env-1", "trace-1");

    expect(getAnchorByTxHash("cafebabe")).toMatchObject({ batch_id: "batch-1", block_number: 42 });
    expect(getAnchorByTraceId("trace-1")).toMatchObject({ batch_id: "batch-1" });
    expect(getAnchorByTraceId("nonexistent")).toBeNull();
    expect(getAnchorByTxHash("nonexistent")).toBeFalsy();
  });

  it("getAnchorLeaves returns leaves joined with envelope type/trace_id", () => {
    const path = freshDbPath();
    initDb(path);
    seedAnchoredEnvelope(path, "env-1", "trace-1");

    const leaves = getAnchorLeaves("batch-1");
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ envelope_id: "env-1", envelope_type: "INTENT", trace_id: "trace-1" });
  });

  it("getAnchors returns all anchor batches", () => {
    const path = freshDbPath();
    initDb(path);
    seedAnchoredEnvelope(path, "env-1", "trace-1");
    expect(getAnchors()).toHaveLength(1);
  });
});

describe("getDisputePackByTraceId", () => {
  it("returns records, entries, and inclusion proofs for an anchored trace", () => {
    const path = freshDbPath();
    initDb(path);
    seedAnchoredEnvelope(path, "env-1", "trace-1");

    const pack = getDisputePackByTraceId("trace-1");
    expect(pack.records).toHaveLength(1);
    expect(pack.entries).toHaveLength(1);
    expect(pack.inclusionProofs).toHaveLength(1);
    expect(pack.inclusionProofs[0].batch.batch_id).toBe("batch-1");
  });

  it("returns empty results for a trace with no envelopes", () => {
    initDb(freshDbPath());
    const pack = getDisputePackByTraceId("unknown-trace");
    expect(pack.records).toEqual([]);
    expect(pack.entries).toEqual([]);
    expect(pack.inclusionProofs).toEqual([]);
  });

  it("omits inclusion proofs for envelopes that aren't yet anchored", () => {
    initDb(freshDbPath());
    saveEnvelope("id-1", "INTENT", "trace-1", {}, "sig");
    const pack = getDisputePackByTraceId("trace-1");
    expect(pack.entries).toHaveLength(1);
    expect(pack.inclusionProofs).toEqual([]);
  });
});

describe("clearEnvelopes", () => {
  it("clears envelopes, anchors, anchor_leaves, and thoughts", () => {
    const path = freshDbPath();
    initDb(path);
    seedAnchoredEnvelope(path, "env-1", "trace-1");
    saveThought("bank-b", "hello");

    clearEnvelopes();

    expect(getEnvelopes()).toHaveLength(0);
    expect(getAnchors()).toHaveLength(0);
    expect(getThoughts()).toHaveLength(0);
  });
});

describe("saveThought / getThoughts", () => {
  it("persists and retrieves thoughts in order", () => {
    initDb(freshDbPath());
    saveThought("bank-b", "first");
    saveThought("bank-b", "second");
    expect(getThoughts().map((t: any) => t.text)).toEqual(["first", "second"]);
  });
});

describe("backfillChain (legacy rows without seq)", () => {
  it("assigns seq + prev_hash to pre-existing rows lacking them", () => {
    const path = freshDbPath();
    initDb(path);

    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO envelopes (id, type, trace_id, raw_payload, signature, created_at, seq, prev_hash) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)"
      )
      .run("legacy-1", "INTENT", "trace-legacy", "{}", "sig", new Date().toISOString());
    raw.close();

    initDb(path);

    const chain = getChain();
    expect(chain).toHaveLength(1);
    expect(chain[0].seq).toBe(0);
    expect(verifyEnvelopeChain().valid).toBe(true);
  });
});
