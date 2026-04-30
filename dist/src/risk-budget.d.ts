/**
 * TrustAgentAI — Risk Budget Engine (D4)
 *
 * Enforces per-agent spending limits and action authority budgets.
 * Called by the Trust Proxy before issuing an Acceptance Receipt.
 *
 * In production this would load VC (Verifiable Credential) policies
 * from a credential store. Here we use an in-memory policy map.
 */
export interface AgentPolicy {
    did: string;
    maxSingleActionUsd: number;
    dailyBudgetUsd: number;
    allowedTools: string[];
}
export interface BudgetCheckResult {
    allowed: boolean;
    reason?: string;
    remainingDailyUsd?: number;
}
export declare class RiskBudgetEngine {
    private policies;
    private spendLedger;
    registerPolicy(policy: AgentPolicy): void;
    /**
     * Check whether a given agent is allowed to execute a tool call
     * with a given estimated cost.
     */
    check(initiatorDid: string, toolName: string, estimatedCostUsd: number): BudgetCheckResult;
    /**
     * Record actual spend after successful execution.
     */
    recordSpend(initiatorDid: string, amountUsd: number): void;
    private _rollingSpend;
}
//# sourceMappingURL=risk-budget.d.ts.map