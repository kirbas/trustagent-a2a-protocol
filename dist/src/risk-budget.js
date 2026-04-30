/**
 * TrustAgentAI — Risk Budget Engine (D4)
 *
 * Enforces per-agent spending limits and action authority budgets.
 * Called by the Trust Proxy before issuing an Acceptance Receipt.
 *
 * In production this would load VC (Verifiable Credential) policies
 * from a credential store. Here we use an in-memory policy map.
 */
const DAY_MS = 24 * 60 * 60 * 1_000;
export class RiskBudgetEngine {
    policies = new Map();
    spendLedger = new Map(); // did → spend history
    registerPolicy(policy) {
        this.policies.set(policy.did, policy);
    }
    /**
     * Check whether a given agent is allowed to execute a tool call
     * with a given estimated cost.
     */
    check(initiatorDid, toolName, estimatedCostUsd) {
        const policy = this.policies.get(initiatorDid);
        if (!policy) {
            return { allowed: false, reason: `No policy registered for ${initiatorDid}` };
        }
        // Tool whitelist
        if (!policy.allowedTools.includes("*") && !policy.allowedTools.includes(toolName)) {
            return { allowed: false, reason: `Tool '${toolName}' not in allowedTools for ${initiatorDid}` };
        }
        // Single-action cap
        if (estimatedCostUsd > policy.maxSingleActionUsd) {
            return {
                allowed: false,
                reason: `Action cost $${estimatedCostUsd} exceeds single-action cap $${policy.maxSingleActionUsd}`,
            };
        }
        // Rolling 24h budget
        const spent = this._rollingSpend(initiatorDid);
        const remaining = policy.dailyBudgetUsd - spent;
        if (estimatedCostUsd > remaining) {
            return {
                allowed: false,
                reason: `Insufficient daily budget. Remaining: $${remaining.toFixed(2)}, Requested: $${estimatedCostUsd}`,
                remainingDailyUsd: remaining,
            };
        }
        return { allowed: true, remainingDailyUsd: remaining - estimatedCostUsd };
    }
    /**
     * Record actual spend after successful execution.
     */
    recordSpend(initiatorDid, amountUsd) {
        const records = this.spendLedger.get(initiatorDid) ?? [];
        records.push({ timestampMs: Date.now(), amountUsd });
        this.spendLedger.set(initiatorDid, records);
    }
    _rollingSpend(did) {
        const cutoff = Date.now() - DAY_MS;
        const records = this.spendLedger.get(did) ?? [];
        // Purge old records lazily
        const fresh = records.filter((r) => r.timestampMs >= cutoff);
        this.spendLedger.set(did, fresh);
        return fresh.reduce((sum, r) => sum + r.amountUsd, 0);
    }
}
//# sourceMappingURL=risk-budget.js.map