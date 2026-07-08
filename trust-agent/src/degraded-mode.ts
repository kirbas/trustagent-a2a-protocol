/**
 * TrustAgentAI — Degraded-mode discipline (Delta #7)
 *
 * DISPUTE_HARDENING Decision #8 ("sync inline + degraded-mode fallback") and
 * #9 ("on-chain heartbeat + reconciliation window + value cap") together
 * define the availability escape-hatch: when the inline witness co-sign
 * can't be obtained, a transaction MAY still proceed — but bounded, and
 * provably marked as unwitnessed rather than silently treated as if it were.
 *
 *  - `DegradedModeGate` decides, live, whether a given transaction may fall
 *    back to degraded mode: a value cap (no single degraded transaction may
 *    exceed it) and a rolling-window rate cap (no more than N degraded
 *    transactions per window) — the same "bound the blast radius of an
 *    outage" idea as `RiskBudgetEngine`, applied to outages instead of spend.
 *  - `buildDegradedRecord` produces the artifact persisted in place of a
 *    `CoSignReceipt`: honest about *why* there's no witness signature, and
 *    carrying a `reconcile_by` deadline.
 *  - `reconciliationStatus` is the audit-side answer to "is this OK?" — pure
 *    function of the record, the deadline, and whether a co-sign eventually
 *    showed up for that trace_id. No separate in-memory tracker: the
 *    envelope hash-chain (DEGRADED row + a later COSIGN row for the same
 *    trace_id, or the absence of one) is already the source of truth, same
 *    as every other append-only record in this codebase.
 */

export interface DegradedModePolicy {
  /** No single degraded transaction may exceed this value. */
  maxValueUsd: number;
  /** At most this many degraded transactions per rolling window. */
  maxDegradedPerWindow: number;
  windowSeconds: number;
  /** How long a degraded transaction has to be retroactively co-signed. */
  reconciliationSeconds: number;
}

export type DegradedDecision =
  | { allowed: true; reconcileBy: string }
  | { allowed: false; reason: string };

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

/** Live, stateful gate: value cap + rolling-window rate cap on degraded-mode fallbacks. */
export class DegradedModeGate {
  private readonly recent: string[] = [];

  constructor(private readonly policy: DegradedModePolicy) {}

  evaluate(valueUsd: number, now: string): DegradedDecision {
    if (valueUsd > this.policy.maxValueUsd) {
      return { allowed: false, reason: `value ${valueUsd} exceeds degraded-mode cap ${this.policy.maxValueUsd}` };
    }

    this.pruneBefore(new Date(now).getTime() - this.policy.windowSeconds * 1000);
    if (this.recent.length >= this.policy.maxDegradedPerWindow) {
      return {
        allowed: false,
        reason: `degraded-mode rate cap (${this.policy.maxDegradedPerWindow} per ${this.policy.windowSeconds}s) exceeded`,
      };
    }

    this.recent.push(now);
    return { allowed: true, reconcileBy: addSeconds(now, this.policy.reconciliationSeconds) };
  }

  private pruneBefore(cutoffMs: number): void {
    while (this.recent.length && new Date(this.recent[0]).getTime() < cutoffMs) {
      this.recent.shift();
    }
  }
}

/** The record persisted in place of a witness CoSignReceipt for a degraded transaction. */
export interface DegradedRecord {
  trace_id: string;
  reason: string;
  timestamp: string;
  reconcile_by: string;
}

export function buildDegradedRecord(
  traceId: string,
  reason: string,
  now: string,
  reconciliationSeconds: number
): DegradedRecord {
  return { trace_id: traceId, reason, timestamp: now, reconcile_by: addSeconds(now, reconciliationSeconds) };
}

export type ReconciliationStatus = "PENDING" | "RECONCILED" | "EXPIRED_UNRECONCILED";

/**
 * Audit-side status for a degraded record: RECONCILED if a co-sign for this
 * trace_id eventually showed up (regardless of when); otherwise PENDING
 * until `reconcile_by`, then EXPIRED_UNRECONCILED — a provable red flag
 * (DoD #5: a valid witness co-signature, OR a valid, capped, *reconciled*
 * degraded record; an expired one is neither).
 */
export function reconciliationStatus(
  record: DegradedRecord,
  hasCoSign: boolean,
  now: string
): ReconciliationStatus {
  if (hasCoSign) return "RECONCILED";
  return new Date(now).getTime() > new Date(record.reconcile_by).getTime() ? "EXPIRED_UNRECONCILED" : "PENDING";
}
