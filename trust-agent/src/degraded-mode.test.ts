import { describe, it, expect } from "vitest";
import { DegradedModeGate, buildDegradedRecord, reconciliationStatus } from "./degraded-mode.js";
import type { DegradedModePolicy } from "./degraded-mode.js";

const POLICY: DegradedModePolicy = {
  maxValueUsd: 1000,
  maxDegradedPerWindow: 2,
  windowSeconds: 60,
  reconciliationSeconds: 300,
};

describe("DegradedModeGate.evaluate", () => {
  it("allows a transaction within the value and rate caps, with a reconcile deadline", () => {
    const gate = new DegradedModeGate(POLICY);
    const decision = gate.evaluate(500, "2026-01-01T00:00:00.000Z");
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.reconcileBy).toBe("2026-01-01T00:05:00.000Z");
    }
  });

  it("rejects a transaction whose value exceeds the degraded-mode cap", () => {
    const gate = new DegradedModeGate(POLICY);
    const decision = gate.evaluate(5000, "2026-01-01T00:00:00.000Z");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/exceeds/);
    }
  });

  it("rejects once the rolling-window rate cap is hit", () => {
    const gate = new DegradedModeGate(POLICY);
    expect(gate.evaluate(100, "2026-01-01T00:00:00.000Z").allowed).toBe(true);
    expect(gate.evaluate(100, "2026-01-01T00:00:10.000Z").allowed).toBe(true);
    const third = gate.evaluate(100, "2026-01-01T00:00:20.000Z");
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.reason).toMatch(/rate cap/);
    }
  });

  it("allows again once old entries fall outside the rolling window", () => {
    const gate = new DegradedModeGate(POLICY);
    gate.evaluate(100, "2026-01-01T00:00:00.000Z");
    gate.evaluate(100, "2026-01-01T00:00:10.000Z");
    const afterWindow = gate.evaluate(100, "2026-01-01T00:01:01.000Z");
    expect(afterWindow.allowed).toBe(true);
  });
});

describe("buildDegradedRecord", () => {
  it("builds a record with the given reason and a reconcile-by deadline", () => {
    const record = buildDegradedRecord(
      "urn:uuid:abc",
      "witness unreachable",
      "2026-01-01T00:00:00.000Z",
      300
    );
    expect(record).toEqual({
      trace_id: "urn:uuid:abc",
      reason: "witness unreachable",
      timestamp: "2026-01-01T00:00:00.000Z",
      reconcile_by: "2026-01-01T00:05:00.000Z",
    });
  });
});

describe("reconciliationStatus", () => {
  const record = buildDegradedRecord("urn:uuid:abc", "witness unreachable", "2026-01-01T00:00:00.000Z", 300);

  it("is RECONCILED once a co-sign exists, regardless of the deadline", () => {
    expect(reconciliationStatus(record, true, "2026-01-02T00:00:00.000Z")).toBe("RECONCILED");
  });

  it("is PENDING before the deadline with no co-sign yet", () => {
    expect(reconciliationStatus(record, false, "2026-01-01T00:01:00.000Z")).toBe("PENDING");
  });

  it("is EXPIRED_UNRECONCILED once the deadline passes with no co-sign", () => {
    expect(reconciliationStatus(record, false, "2026-01-01T00:10:00.000Z")).toBe("EXPIRED_UNRECONCILED");
  });
});
