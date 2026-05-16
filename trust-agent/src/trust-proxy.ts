import { createHmac, randomUUID } from "crypto";
import { buildIntentEnvelope, buildAcceptanceEnvelope, buildExecutionEnvelope } from "./envelopes.js";
import type { IntentEnvelope, AcceptanceEnvelope, ExecutionEnvelope, ProxyConfig } from "./types.js";
import { Ledger } from "./ledger.js";
import { BudgetEngine } from "./budget.js";

export class ProxyAGateway {
  private cfg: ProxyConfig;
  private ledger: Ledger;
  private budgetEngine: BudgetEngine;
  private intentMeta = new Map<string, { initiatorDid: string; estimatedCostUsd: number }>();
  private intentEntryHashes = new Map<string, string>();

  constructor(cfg: ProxyConfig) {
    this.cfg = cfg;
    this.ledger = new Ledger(cfg.dbPath, cfg.proxyKey);
    this.budgetEngine = new BudgetEngine(cfg.dbPath, cfg.proxyKey);
  }

  async handleIntent(intent: IntentEnvelope): Promise<IntentEnvelope> {
    const hash = this.ledger.append("INTENT_RECORD", intent, []);
    this.intentEntryHashes.set(intent.trace_id, hash);
    
    const meta = {
      initiatorDid: intent.initiator_did,
      estimatedCostUsd: intent.params?._estimated_cost_usd ?? 0,
    };
    this.intentMeta.set(intent.trace_id, meta);
    
    return intent;
  }

  async forwardToolCall(intent: IntentEnvelope): Promise<ExecutionEnvelope> {
    const response = await fetch(`${this.cfg.proxyBUrl}/executed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intent),
    });

    if (!response.ok) {
      throw new Error(`Proxy B rejected execution: ${response.statusText}`);
    }

    const execution = await response.json() as ExecutionEnvelope;
    this.ledger.append("EXECUTION_RECORD", execution, [this.intentEntryHashes.get(execution.trace_id) || ""]);
    return execution;
  }
}

export class ProxyBGateway {
  private cfg: ProxyConfig;
  private ledger: Ledger;
  private budgetEngine: BudgetEngine;
  private intentMeta = new Map<string, { initiatorDid: string; estimatedCostUsd: number }>();
  private intentEntryHashes = new Map<string, string>();

  constructor(cfg: ProxyConfig) {
    this.cfg = cfg;
    this.ledger = new Ledger(cfg.dbPath, cfg.proxyKey);
    this.budgetEngine = new BudgetEngine(cfg.dbPath, cfg.proxyKey);
  }

  async handleIntent(intent: IntentEnvelope): Promise<AcceptanceEnvelope> {
    const hash = this.ledger.append("INTENT_RECORD", intent, []);
    this.intentEntryHashes.set(intent.trace_id, hash);
    
    const meta = {
      initiatorDid: intent.initiator_did,
      estimatedCostUsd: intent.params?._estimated_cost_usd ?? 0,
    };
    this.intentMeta.set(intent.trace_id, meta);

    const acceptance = await buildAcceptanceEnvelope({
      intentEnvelope: intent,
      status: "ACCEPTED",
      proxyKey: this.cfg.proxyKey,
    });

    this.ledger.append("ACCEPTANCE_RECORD", acceptance, [hash]);
    return acceptance;
  }

  async handleExecution(execution: ExecutionEnvelope): Promise<ExecutionEnvelope> {
    const intentHash = this.intentEntryHashes.get(execution.trace_id);
    
    // Proxy B explicitly signs the final ExecutionEnvelope for bilateral integrity
    const dualSignedExecution = await buildExecutionEnvelope({
      intentEnvelope: execution.intent_envelope || (execution as any),
      acceptanceReceipt: execution.acceptance_receipt || (execution as any),
      status: execution.status,
      outputData: execution.result?.output_hash || {},
      proxyKey: this.cfg.proxyKey,
    });

    this.ledger.append(
      "EXECUTION_RECORD",
      dualSignedExecution,
      intentHash ? [intentHash] : []
    );

    // D4: Record actual spend only on successful execution
    if (execution.status === "COMPLETED") {
      const meta = this.intentMeta.get(execution.trace_id);
      if (meta) {
        this.budgetEngine.recordSpend(meta.initiatorDid, meta.estimatedCostUsd);
      }
    }

    // Clean up stored metadata
    this.intentMeta.delete(execution.trace_id);
    this.intentEntryHashes.delete(execution.trace_id);

    return dualSignedExecution;
  }
}
