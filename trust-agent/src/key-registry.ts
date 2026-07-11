/**
 * TrustAgentAI — Append-only key-transparency registry (Delta #6)
 *
 * Replaces the mutable "last write wins" key registration (`Map.set(kid,
 * pubkey)`) used through Delta #5. A party (DID) may hold at most one
 * *currently valid* key epoch at a time:
 *  - The FIRST registration for a DID is trust-on-first-use (no prior key
 *    exists to vouch for it — same trust assumption `register-peer-key`
 *    always had).
 *  - Every SUBSEQUENT registration for that DID is a rotation and MUST be
 *    endorsed: signed by the party's current (or last-known) key over a
 *    `RotationAttestation` binding old -> new. This is what closes
 *    "whose key" repudiation (DISPUTE_HARDENING Decision #10) — an attacker
 *    without the prior private key cannot hijack someone else's identity.
 *  - Revocation closes the active epoch's validity window rather than
 *    deleting it (revocation-as-append): a revoked key's past signatures
 *    remain verifiable, but it can no longer authorize a further rotation.
 *
 * Recovering an identity after its last key is lost/revoked (with no prior
 * key available to endorse a replacement) is an explicit, out-of-scope
 * bootstrap problem for this MVP — see docs/execution_plan.md §5 Delta #6.
 */

import { signEnvelope, verifySignature } from "./crypto.js";
import type { KeyPair, SignatureBlock } from "./crypto.js";

/** One key's validity window for a given DID. */
export interface KeyEpoch {
  kid: string;
  publicKey: Uint8Array;
  validFrom: string;
  validUntil: string | null;
}

/** What the prior key signs to authorize its own replacement. */
export interface RotationAttestation {
  did: string;
  new_kid: string;
  new_public_key_hex: string;
  timestamp: string;
}

/** A kid is always `did:workload:X#key-N` — the DID is everything before `#`. */
export function didFromKid(kid: string): string {
  return kid.split("#")[0];
}

export function buildRotationAttestation(
  did: string,
  newKid: string,
  newPublicKeyHex: string,
  timestamp: string
): RotationAttestation {
  return { did, new_kid: newKid, new_public_key_hex: newPublicKeyHex, timestamp };
}

/** Convenience for callers who hold the prior KeyPair directly. */
export async function signRotation(
  attestation: RotationAttestation,
  priorKey: KeyPair
): Promise<SignatureBlock> {
  return signEnvelope(attestation as unknown as Record<string, unknown>, priorKey, "proxy");
}

export class KeyRegistry {
  private readonly epochsByDid = new Map<string, KeyEpoch[]>();
  private readonly epochByKid = new Map<string, Uint8Array>();

  /**
   * Register a new key for `did`. First-ever call for a DID needs no
   * `endorsement`. Every later call MUST carry a signature (from the DID's
   * last-known key) over `buildRotationAttestation(did, kid, publicKeyHex, now)` —
   * verified before the new epoch is accepted.
   */
  async register(
    did: string,
    kid: string,
    publicKeyHex: string,
    now: string,
    endorsement?: SignatureBlock
  ): Promise<void> {
    const publicKey = new Uint8Array(Buffer.from(publicKeyHex, "hex"));
    const existing = this.epochByKid.get(kid);
    if (existing) {
      if (Buffer.from(existing).equals(Buffer.from(publicKey))) return; // idempotent resubmit
      throw new Error(`kid already registered with a different key: ${kid}`);
    }

    const epochs = this.epochsByDid.get(did) ?? [];
    const last = epochs[epochs.length - 1];

    if (last) {
      if (!endorsement) {
        throw new Error(`registration for ${did} requires endorsement from the prior key (${last.kid})`);
      }
      const attestation = buildRotationAttestation(did, kid, publicKeyHex, now);
      await verifySignature(attestation as unknown as Record<string, unknown>, endorsement, last.publicKey);
      if (last.validUntil === null) last.validUntil = now;
    }

    const epoch: KeyEpoch = { kid, publicKey, validFrom: now, validUntil: null };
    this.epochsByDid.set(did, [...epochs, epoch]);
    this.epochByKid.set(kid, publicKey);
  }

  /**
   * Close the currently active epoch for `did` without replacing it.
   * `endorsement` must be signed by that same active key, over
   * `{ did, revoke_kid, timestamp }` — proving the caller still controls it.
   */
  async revoke(did: string, now: string, endorsement: SignatureBlock): Promise<void> {
    const epochs = this.epochsByDid.get(did) ?? [];
    const current = epochs.find((e) => e.validUntil === null);
    if (!current) throw new Error(`no active key to revoke for ${did}`);

    const attestation = { did, revoke_kid: current.kid, timestamp: now };
    await verifySignature(attestation as unknown as Record<string, unknown>, endorsement, current.publicKey);
    current.validUntil = now;
  }

  /** Raw lookup by kid, regardless of current validity (history is kept). */
  resolveByKid(kid: string): Uint8Array | undefined {
    return this.epochByKid.get(kid);
  }

  /** Alias for {@link resolveByKid} — makes KeyRegistry a drop-in for any
   *  call site that used to hold a plain `Map<string, Uint8Array>`. */
  get(kid: string): Uint8Array | undefined {
    return this.resolveByKid(kid);
  }

  /** The key that was valid for `did` at `timestamp` (or undefined). */
  resolveAt(did: string, timestamp: string): Uint8Array | undefined {
    const epochs = this.epochsByDid.get(did) ?? [];
    const epoch = epochs.find(
      (e) => e.validFrom <= timestamp && (e.validUntil === null || timestamp < e.validUntil)
    );
    return epoch?.publicKey;
  }

  /** Full epoch history for a DID, oldest first — the transparency log. */
  getHistory(did: string): readonly KeyEpoch[] {
    return this.epochsByDid.get(did) ?? [];
  }

  // ─── kid-keyed convenience wrappers ────────────────────────────────────────
  // A caller with an HTTP request usually only has a kid, not its DID — these
  // derive it via didFromKid so every call site doesn't have to.

  registerByKid(
    kid: string,
    publicKeyHex: string,
    endorsement?: SignatureBlock,
    now: string = new Date().toISOString()
  ): Promise<void> {
    return this.register(didFromKid(kid), kid, publicKeyHex, now, endorsement);
  }

  revokeByKid(kid: string, endorsement: SignatureBlock, now: string = new Date().toISOString()): Promise<void> {
    return this.revoke(didFromKid(kid), now, endorsement);
  }

  historyByKid(kid: string): readonly KeyEpoch[] {
    return this.getHistory(didFromKid(kid));
  }
}
