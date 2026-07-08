/**
 * TrustAgentAI — WORM blob records + write-once store (Delta #5)
 *
 * `buildWormRecord` assembles the encrypted, content-addressed record for one
 * transaction's plaintext (args or output): a fresh per-tx DEK encrypts the
 * content once, then the SAME DEK is wrapped (envelope-encrypted) once per
 * holder KEK — including a separate regulator escrow entry. No holder ever
 * sees another holder's key material, and none of them see the DEK itself
 * except through their own wrapped copy.
 *
 * `WormBlobStore` is the generic write-once keyed store used both locally
 * (proxies) and remotely (the witness's `/blob` endpoint): a given id may be
 * written once; a repeat write of byte-identical content is a no-op, and a
 * repeat write of DIFFERENT content under the same id is a WORM violation.
 */

import { contentAddress, encryptContent, decryptContent, wrapDek, unwrapDek, generateDek } from "./worm.js";
import type { EncryptedBlob, WrappedKey } from "./worm.js";

/** A party who may independently decrypt WORM content, identified by id. */
export interface Holder {
  id: string;
  kek: Buffer;
}

/** The full encrypted record for one piece of plaintext, cross-holdable. */
export interface WormBlobRecord {
  contentHash: string;
  ciphertext: string;
  iv: string;
  tag: string;
  wrappedDeks: Record<string, WrappedKey>;
}

/**
 * Encrypt `plaintext` under a fresh DEK and wrap that DEK for every holder
 * plus a separate escrow holder (regulator). `contentHash` is `sha256(plaintext)`
 * — the same commitment already carried as `args_hash`/`output_hash` in the
 * envelope (DoD #1).
 */
export function buildWormRecord(
  plaintext: Buffer,
  holders: readonly Holder[],
  escrow: Holder
): WormBlobRecord {
  const contentHash = contentAddress(plaintext);
  const dek = generateDek();
  const enc: EncryptedBlob = encryptContent(plaintext, dek);

  const wrappedDeks: Record<string, WrappedKey> = {};
  for (const holder of holders) {
    wrappedDeks[holder.id] = wrapDek(dek, holder.kek);
  }
  wrappedDeks[escrow.id] = wrapDek(dek, escrow.kek);

  return { contentHash, ciphertext: enc.ciphertext, iv: enc.iv, tag: enc.tag, wrappedDeks };
}

/**
 * Decrypt a WORM record as a given holder. Throws if the holder has no
 * wrapped DEK on this record, if the KEK is wrong (GCM auth failure on
 * unwrap), or if the recovered plaintext no longer matches `contentHash`.
 */
export function decryptWormRecord(record: WormBlobRecord, holderId: string, kek: Buffer): Buffer {
  const wrapped = record.wrappedDeks[holderId];
  if (!wrapped) throw new Error(`holder "${holderId}" has no wrapped DEK on this record`);

  const dek = unwrapDek(wrapped, kek);
  const plaintext = decryptContent({ ciphertext: record.ciphertext, iv: record.iv, tag: record.tag }, dek);

  if (contentAddress(plaintext) !== record.contentHash) {
    throw new Error("decrypted content does not match the record's content hash");
  }
  return plaintext;
}

export interface WormPutResult<T> {
  record: T;
  created: boolean;
}

/**
 * Generic write-once store keyed by content id. First write wins; a repeat
 * write with byte-identical (serialized) content is idempotent; a repeat
 * write with DIFFERENT content under the same id is rejected — the WORM
 * invariant, enforced whether the id came from a locally-computed content
 * hash or a caller-declared one (e.g. an HTTP `PUT /blob/:contentHash`).
 */
export class WormBlobStore<T> {
  private readonly records = new Map<string, T>();

  constructor(private readonly serialize: (record: T) => string) {}

  put(id: string, record: T): WormPutResult<T> {
    const existing = this.records.get(id);
    if (existing !== undefined) {
      if (this.serialize(existing) === this.serialize(record)) {
        return { record: existing, created: false };
      }
      throw new Error(`WORM violation: "${id}" already stored with different content`);
    }
    this.records.set(id, record);
    return { record, created: true };
  }

  get(id: string): T | undefined {
    return this.records.get(id);
  }
}
