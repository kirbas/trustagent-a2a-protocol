/**
 * TrustAgentAI Cloud — CoSignService (Delta #3)
 *
 * Orchestrates the inline witness path: verify both proxy signatures against
 * the witness's OWN key registry, co-sign the transaction, and append the
 * receipt to the witness hash-chain. The pure crypto lives in the shared
 * `co-sign.ts` module; SQL/chain storage lives in `db.ts`. This class wires
 * them and enforces idempotency.
 */

import {
  verifyHandshake,
  buildCoSignReceipt,
  type IntentEnvelope,
  type AcceptanceReceipt,
  type CoSignReceipt,
  type KeyPair,
} from "@trustagentai/a2a-core";
import { appendCoSign, getCoSignByTrace } from "./db.js";

export interface CoSignOutcome {
  receipt: CoSignReceipt;
  seq: number;
  prev_hash: string;
  idempotent: boolean;
}

export class CoSignService {
  /** kid → public key. Populated by each bank registering with the witness. */
  private readonly keys = new Map<string, Uint8Array>();

  constructor(private readonly witnessKey: KeyPair) {}

  /** Register a proxy's public key so the witness can verify its signatures. */
  registerKey(kid: string, publicKeyHex: string): void {
    this.keys.set(kid, Buffer.from(publicKeyHex, "hex"));
  }

  /**
   * Co-sign a transaction inline. Idempotent on `trace_id`: a repeat request
   * returns the existing receipt without re-verifying or advancing the chain.
   * Throws if the handshake is invalid (bad/unknown signature, unbound intent,
   * or a non-ACCEPTED decision) — the caller MUST NOT finalize on a throw.
   */
  async coSign(intent: IntentEnvelope, acceptance: AcceptanceReceipt): Promise<CoSignOutcome> {
    const existing = getCoSignByTrace(intent.trace_id);
    if (existing) {
      return { ...existing, idempotent: true };
    }

    await verifyHandshake(intent, acceptance, (kid) => this.keys.get(kid));
    const receipt = await buildCoSignReceipt(intent, acceptance, this.witnessKey);
    const { seq, prev_hash } = appendCoSign(intent.trace_id, receipt);
    return { receipt, seq, prev_hash, idempotent: false };
  }
}
