/**
 * TrustAgentAI — Cryptographic Primitives
 * Ed25519 signatures + SHA-256 + JCS (RFC 8785)
 *
 * Dependencies:
 *   npm install @noble/ed25519 canonicalize
 *   npm install --save-dev @types/node typescript
 */

import * as ed from "@noble/ed25519";
import _canonicalize = require("canonicalize");
const canonicalize = (_canonicalize.default ?? _canonicalize) as (input: unknown) => string | undefined;
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KeyPair {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array;  // 32 bytes
  kid: string;            // e.g. "did:workload:proxy-A#key-1"
}

export interface SignatureBlock {
  role: "proxy" | "agent";
  kid: string;
  alg: "EdDSA";
  signed_digest: string;  // hex SHA-256 of the JCS envelope
  value: string;          // base64url Ed25519 signature
  agent_attestation_ref?: string;
}

// ─── Key Generation ───────────────────────────────────────────────────────────

export async function generateKeyPair(kid: string): Promise<KeyPair> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, kid };
}

// ─── Durable, Custodied Keystore ───────────────────────────────────────────────

interface KeystoreFile {
  kid: string;
  publicKey: string;   // hex
  iv: string;           // hex, 12 bytes
  ciphertext: string;   // hex, encrypted 32-byte private key
  tag: string;           // hex, GCM auth tag
}

function parseKek(kek: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(kek)) {
    throw new Error("KEYSTORE_KEK must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(kek, "hex");
}

/**
 * Load an Ed25519 identity from an encrypted keystore file, creating it on
 * first use. The private key is encrypted at rest with AES-256-GCM under a
 * KEK supplied by the caller (never derived from anything stored alongside
 * the keystore, e.g. the database) — a wrong/missing KEK fails loudly rather
 * than silently minting a new identity.
 */
export async function loadOrCreateKeyPair(
  kid: string,
  keystorePath: string,
  kek: string
): Promise<KeyPair> {
  const kekBuffer = parseKek(kek);

  if (existsSync(keystorePath)) {
    const file: KeystoreFile = JSON.parse(readFileSync(keystorePath, "utf8"));
    const iv = Buffer.from(file.iv, "hex");
    const tag = Buffer.from(file.tag, "hex");
    const decipher = createDecipheriv("aes-256-gcm", kekBuffer, iv);
    decipher.setAuthTag(tag);
    const privateKey = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, "hex")),
      decipher.final(),
    ]);
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    return { privateKey: new Uint8Array(privateKey), publicKey, kid: file.kid };
  }

  const { privateKey, publicKey } = await generateKeyPair(kid);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kekBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  const tag = cipher.getAuthTag();

  const file: KeystoreFile = {
    kid,
    publicKey: Buffer.from(publicKey).toString("hex"),
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    tag: tag.toString("hex"),
  };
  writeFileSync(keystorePath, JSON.stringify(file));

  return { privateKey, publicKey, kid };
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256( JCS(envelope WITHOUT "signatures" field) )
 * This is the canonical hash rule from A2A spec §4 "Hash Target Rule".
 */
export function computeEnvelopeHash(envelope: Record<string, unknown>): string {
  // Strip signatures field before hashing (spec requirement)
  const { signatures: _sig, entry_hash: _eh, ...rest } = envelope as any;
  const canonical = canonicalize(rest);
  if (!canonical) throw new Error("JCS canonicalization failed");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Generic SHA-256 of any JSON-serializable value (JCS).
 */
export function sha256Json(value: unknown): string {
  const canonical = canonicalize(value);
  if (!canonical) throw new Error("JCS canonicalization failed");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * SHA-256 of raw string / Buffer.
 */
export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

// ─── Signing ──────────────────────────────────────────────────────────────────

/**
 * Sign an envelope with Ed25519.
 * Returns a SignatureBlock ready to push into envelope.signatures[].
 */
export async function signEnvelope(
  envelope: Record<string, unknown>,
  keyPair: KeyPair,
  role: "proxy" | "agent" = "proxy",
  attestationRef?: string
): Promise<SignatureBlock> {
  const signed_digest = computeEnvelopeHash(envelope);
  const msgBytes = Buffer.from(signed_digest, "hex");
  const sigBytes = await ed.signAsync(msgBytes, keyPair.privateKey);
  const value = Buffer.from(sigBytes).toString("base64url");

  const block: SignatureBlock = {
    role,
    kid: keyPair.kid,
    alg: "EdDSA",
    signed_digest,
    value,
  };
  if (attestationRef) block.agent_attestation_ref = attestationRef;
  return block;
}

/**
 * Verify a signature block against the envelope.
 * Throws if invalid.
 */
export async function verifySignature(
  envelope: Record<string, unknown>,
  sig: SignatureBlock,
  publicKey: Uint8Array
): Promise<void> {
  const expectedDigest = computeEnvelopeHash(envelope);
  if (sig.signed_digest !== expectedDigest) {
    throw new Error(
      `signed_digest mismatch: expected ${expectedDigest}, got ${sig.signed_digest}`
    );
  }
  const sigBytes = Buffer.from(sig.value, "base64url");
  const msgBytes = Buffer.from(sig.signed_digest, "hex");
  const valid = await ed.verifyAsync(sigBytes, msgBytes, publicKey);
  if (!valid) throw new Error(`Ed25519 signature verification failed for kid=${sig.kid}`);
}

// ─── Nonce ────────────────────────────────────────────────────────────────────

export function generateNonce(): string {
  return randomBytes(8).toString("hex");
}
