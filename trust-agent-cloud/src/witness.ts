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
  KeyRegistry,
  type KeyEpoch,
  type IntentEnvelope,
  type AcceptanceReceipt,
  type CoSignReceipt,
  type KeyPair,
  type SignatureBlock,
} from "@trustagentai/a2a-core";
import { appendCoSign, getCoSignByTrace } from "./db.js";

export interface CoSignOutcome {
  receipt: CoSignReceipt;
  seq: number;
  prev_hash: string;
  idempotent: boolean;
}

export class CoSignService {
  /** Append-only key-transparency registry (Delta #6). Populated by each
   *  bank registering (bootstrap) or rotating (endorsed) with the witness. */
  private readonly registry = new KeyRegistry();

  constructor(private readonly witnessKey: KeyPair) {}

  /**
   * Register a proxy's public key so the witness can verify its signatures.
   * The first registration for a DID is trust-on-first-use; any later one
   * for the same DID is a rotation and requires `endorsement` — a signature
   * from the DID's prior key over `buildRotationAttestation(did, kid,
   * publicKeyHex, timestamp)` (see `@trustagentai/a2a-core`'s
   * `key-registry.ts`). `timestamp` MUST be the exact value the caller
   * signed the endorsement over — verification hashes the attestation
   * object, so a regenerated timestamp here would never match. Throws on an
   * unendorsed or badly-endorsed rotation.
   */
  registerKey(
    kid: string,
    publicKeyHex: string,
    endorsement?: SignatureBlock,
    timestamp: string = new Date().toISOString()
  ): Promise<void> {
    return this.registry.registerByKid(kid, publicKeyHex, endorsement, timestamp);
  }

  /**
   * Revoke the currently active key for a DID (identified by any of its
   * kids). `timestamp` must match what the caller signed into
   * `{ did, revoke_kid, timestamp }` when producing `endorsement`.
   */
  revokeKey(kid: string, endorsement: SignatureBlock, timestamp: string = new Date().toISOString()): Promise<void> {
    return this.registry.revokeByKid(kid, endorsement, timestamp);
  }

  /** Full key-epoch history for a DID (identified by any of its kids) — the transparency log. */
  getKeyHistory(kid: string): readonly KeyEpoch[] {
    return this.registry.historyByKid(kid);
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

    await verifyHandshake(intent, acceptance, (kid) => this.registry.resolveByKid(kid));
    const receipt = await buildCoSignReceipt(intent, acceptance, this.witnessKey);
    const { seq, prev_hash } = appendCoSign(intent.trace_id, receipt);
    return { receipt, seq, prev_hash, idempotent: false };
  }
}
