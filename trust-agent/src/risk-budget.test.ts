import { describe, it, expect, vi, afterEach } from "vitest";
import { RiskBudgetEngine, type AgentPolicy } from "./risk-budget.js";

const DID = "did:workload:agent#key-1";

function policy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    did: DID,
    maxSingleActionUsd: 100,
    dailyBudgetUsd: 500,
    allowedTools: ["*"],
    ...overrides,
  };
}

describe("RiskBudgetEngine.check", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("denies when no policy is registered for the initiator", () => {
    const engine = new RiskBudgetEngine();
    const result = engine.check(DID, "transfer", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/No policy registered/);
  });

  it("allows a call within the tool whitelist, single-action cap, and daily budget", () => {
    const engine = new RiskBudgetEngine();
    engine.registerPolicy(policy());
    const result = engine.check(DID, "transfer", 10);
    expect(result.allowed).toBe(true);
    expect(result.remainingDailyUsd).toBe(490);
  });

  it("denies a tool not in the explicit allowedTools whitelist", () => {
    const engine = new RiskBudgetEngine();
    engine.registerPolicy(policy({ allowedTools: ["read"] }));
    const result = engine.check(DID, "transfer", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in allowedTools/);
  });

  it("allows any tool when allowedTools contains the wildcard", () => {
    const engine = new RiskBudgetEngine();
    engine.registerPolicy(policy({ allowedTools: ["*"] }));
    expect(engine.check(DID, "anything", 10).allowed).toBe(true);
  });

  it("denies when the single-action cap is exceeded", () => {
    const engine = new RiskBudgetEngine();
    engine.registerPolicy(policy({ maxSingleActionUsd: 50 }));
    const result = engine.check(DID, "transfer", 51);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/exceeds single-action cap/);
  });

  it("denies when the rolling daily budget is exhausted", () => {
    const engine = new RiskBudgetEngine();
    engine.registerPolicy(policy({ dailyBudgetUsd: 100, maxSingleActionUsd: 1000 }));
    engine.recordSpend(DID, 95);
    const result = engine.check(DID, "transfer", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Insufficient daily budget/);
    expect(result.remainingDailyUsd).toBe(5);
  });

  it("excludes spend older than 24h from the rolling budget window", () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const engine = new RiskBudgetEngine();
    engine.registerPolicy(policy({ dailyBudgetUsd: 100, maxSingleActionUsd: 1000 }));
    engine.recordSpend(DID, 95);

    // Advance 24h + 1ms — the old spend record should age out
    vi.setSystemTime(now + 24 * 60 * 60 * 1000 + 1);
    const result = engine.check(DID, "transfer", 50);
    expect(result.allowed).toBe(true);
    expect(result.remainingDailyUsd).toBe(50);
  });
});

describe("RiskBudgetEngine.recordSpend", () => {
  it("accumulates spend across multiple calls for the same agent", () => {
    const engine = new RiskBudgetEngine();
    engine.registerPolicy(policy({ dailyBudgetUsd: 100, maxSingleActionUsd: 1000 }));
    engine.recordSpend(DID, 30);
    engine.recordSpend(DID, 30);
    const result = engine.check(DID, "transfer", 30);
    expect(result.allowed).toBe(true);
    expect(result.remainingDailyUsd).toBe(10);
  });

  it("tracks spend independently per agent", () => {
    const engine = new RiskBudgetEngine();
    const otherDid = "did:workload:other#key-1";
    engine.registerPolicy(policy({ dailyBudgetUsd: 100, maxSingleActionUsd: 1000 }));
    engine.registerPolicy(policy({ did: otherDid, dailyBudgetUsd: 100, maxSingleActionUsd: 1000 }));
    engine.recordSpend(DID, 90);
    expect(engine.check(otherDid, "transfer", 90).allowed).toBe(true);
  });
});
