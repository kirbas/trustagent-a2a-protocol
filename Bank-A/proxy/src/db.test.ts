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
  saveProvenance,
  getEnvelopesByTraceId,
  clearEnvelopes,
  saveThought,
  getThoughts,
} from "./db.js";

function freshDbPath(): string {
  return join(tmpdir(), `bank-a-db-test-${randomUUID()}.db`);
}

beforeEach(() => {
  setSseBus(null);
});

describe("saveEnvelope / getChain / verifyEnvelopeChain", () => {
  it("assigns seq 0 and the genesis prev_hash to the first envelope", () => {
    initDb(freshDbPath());
    saveEnvelope("id-1", "INTENT", "trace-1", { a: 1 }, "sig-1");
    const chain = getChain();
    expect(chain).toHaveLength(1);
    expect(chain[0].seq).toBe(0);
    expect(verifyEnvelopeChain().valid).toBe(true);
  });

  it("chains subsequent envelopes with incrementing seq and a valid chain", () => {
    initDb(freshDbPath());
    saveEnvelope("id-1", "INTENT", "trace-1", { a: 1 }, "sig-1");
    saveEnvelope("id-2", "ACCEPTANCE", "trace-1", { b: 2 }, "sig-2");
    const chain = getChain();
    expect(chain.map((c) => c.seq)).toEqual([0, 1]);
    expect(verifyEnvelopeChain().valid).toBe(true);
  });

  it("is a no-op on a duplicate id (does not advance the chain)", () => {
    initDb(freshDbPath());
    saveEnvelope("id-1", "INTENT", "trace-1", { a: 1 }, "sig-1");
    saveEnvelope("id-1", "INTENT", "trace-1", { a: 999 }, "sig-1");
    expect(getChain()).toHaveLength(1);
  });

  it("broadcasts system-phase only for INTENT envelopes", () => {
    const bus = { broadcast: vi.fn() };
    setSseBus(bus);
    initDb(freshDbPath());

    saveEnvelope("id-1", "ACCEPTANCE", "trace-1", {}, "sig");
    expect(bus.broadcast).not.toHaveBeenCalled();

    saveEnvelope("id-2", "INTENT", "trace-1", {}, "sig");
    expect(bus.broadcast).toHaveBeenCalledWith("system-phase", { phase: "RUNNING" });
  });

  it("does not throw when no sseBus has been set", () => {
    initDb(freshDbPath());
    expect(() => saveEnvelope("id-1", "INTENT", "trace-1", {}, "sig")).not.toThrow();
  });
});

describe("backfillChain (legacy rows without seq)", () => {
  it("assigns seq + prev_hash to pre-existing rows lacking them", () => {
    const path = freshDbPath();
    initDb(path);

    // Insert a legacy row directly, bypassing saveEnvelope, with seq/prev_hash NULL.
    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO envelopes (id, type, trace_id, raw_payload, signature, created_at, seq, prev_hash) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)"
      )
      .run("legacy-1", "INTENT", "trace-legacy", "{}", "sig", new Date().toISOString());
    raw.close();

    // Re-run initDb on the same file — CREATE TABLE IF NOT EXISTS is a no-op,
    // but backfillChain() runs again and should link the legacy row.
    initDb(path);

    const chain = getChain();
    expect(chain).toHaveLength(1);
    expect(chain[0].seq).toBe(0);
    expect(verifyEnvelopeChain().valid).toBe(true);
  });
});

describe("getEnvelopes / getEnvelopesByTraceId", () => {
  it("returns all envelopes and filters by trace_id", () => {
    initDb(freshDbPath());
    saveEnvelope("id-1", "INTENT", "trace-1", {}, "sig");
    saveEnvelope("id-2", "INTENT", "trace-2", {}, "sig");

    expect(getEnvelopes()).toHaveLength(2);
    expect(getEnvelopesByTraceId("trace-1")).toHaveLength(1);
    expect(getEnvelopesByTraceId("nonexistent")).toHaveLength(0);
  });
});

describe("saveProvenance", () => {
  it("inserts a provenance row and ignores a duplicate content_hash", () => {
    const path = freshDbPath();
    initDb(path);
    saveProvenance("hash-1", "trace-1", "sig-1");
    saveProvenance("hash-1", "trace-2", "sig-2"); // INSERT OR IGNORE — no-op

    const raw = new Database(path);
    const rows = raw.prepare("SELECT * FROM provenance").all() as any[];
    raw.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].tx_id).toBe("trace-1");
  });
});

describe("saveThought / getThoughts", () => {
  it("persists and retrieves thoughts in insertion order", () => {
    initDb(freshDbPath());
    saveThought("bank-a", "first");
    saveThought("bank-a", "second");
    const thoughts = getThoughts();
    expect(thoughts.map((t: any) => t.text)).toEqual(["first", "second"]);
  });
});

describe("clearEnvelopes", () => {
  it("clears envelopes, provenance, and thoughts tables", () => {
    initDb(freshDbPath());
    saveEnvelope("id-1", "INTENT", "trace-1", {}, "sig");
    saveProvenance("hash-1", "trace-1", "sig-1");
    saveThought("bank-a", "hello");

    clearEnvelopes();

    expect(getEnvelopes()).toHaveLength(0);
    expect(getThoughts()).toHaveLength(0);
  });
});
