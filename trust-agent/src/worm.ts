/**
 * TrustAgentAI — WORM content encryption primitives (Delta #5)
 *
 * Pure crypto for the content-addressed, envelope-encrypted WORM store:
 * generate a per-transaction DEK, encrypt/decrypt content under it (reusing
 * the AES-256-GCM pattern from crypto.ts's keystore), and wrap/unwrap that
 * DEK under a holder's KEK so multiple parties can each independently
 * decrypt without ever sharing the DEK in the clear. Storage/wiring lives in
 * `worm-store.ts` and the service layers; this module has no I/O.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import _canonicalize = require("canonicalize");
const canonicalize = (_canonicalize.default ?? _canonicalize) as (input: unknown) => string | undefined;

export interface EncryptedBlob {
  iv: string;         // hex, 12 bytes
  ciphertext: string; // hex
  tag: string;        // hex, GCM auth tag
}

/** A DEK wrapped (encrypted) under one holder's KEK. Same shape as EncryptedBlob. */
export type WrappedKey = EncryptedBlob;

/** Fresh random 256-bit content-encryption key, one per transaction. */
export function generateDek(): Uint8Array {
  return randomBytes(32);
}

/**
 * JCS-canonical UTF-8 bytes of a JSON-serializable value. Hashing these bytes
 * with {@link contentAddress} reproduces `sha256Json(value)` from crypto.ts —
 * the value already committed as `args_hash`/`output_hash` in the envelope.
 */
export function canonicalBytes(value: unknown): Buffer {
  const canonical = canonicalize(value);
  if (!canonical) throw new Error("JCS canonicalization failed");
  return Buffer.from(canonical, "utf8");
}

/** Content address of raw bytes: hex SHA-256. This is the WORM blob id. */
export function contentAddress(plaintext: Buffer): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Encrypt content under a DEK with AES-256-GCM (random IV, authenticated). */
export function encryptContent(plaintext: Buffer, dek: Uint8Array): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(dek), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), ciphertext: ciphertext.toString("hex"), tag: tag.toString("hex") };
}

/** Decrypt content encrypted by {@link encryptContent}. Throws on tamper or wrong DEK. */
export function decryptContent(blob: EncryptedBlob, dek: Uint8Array): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(dek), Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "hex")), decipher.final()]);
}

/** Wrap (encrypt) a DEK under a holder's KEK — envelope-encryption. */
export function wrapDek(dek: Uint8Array, kek: Buffer): WrappedKey {
  return encryptContent(Buffer.from(dek), kek);
}

/** Unwrap a DEK wrapped by {@link wrapDek}. Throws on tamper or wrong KEK. */
export function unwrapDek(wrapped: WrappedKey, kek: Buffer): Uint8Array {
  return new Uint8Array(decryptContent(wrapped, kek));
}
