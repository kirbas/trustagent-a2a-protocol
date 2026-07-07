import { describe, it, expect } from "vitest";
import { sha256Json } from "./crypto.js";
import {
  generateDek,
  canonicalBytes,
  contentAddress,
  encryptContent,
  decryptContent,
  wrapDek,
  unwrapDek,
} from "./worm.js";

const holderKek = Buffer.from("a".repeat(64), "hex");
const otherKek = Buffer.from("b".repeat(64), "hex");

describe("generateDek", () => {
  it("returns a fresh 32-byte key on every call", () => {
    const dek1 = generateDek();
    const dek2 = generateDek();
    expect(dek1).toHaveLength(32);
    expect(Buffer.from(dek1).equals(Buffer.from(dek2))).toBe(false);
  });
});

describe("contentAddress / canonicalBytes (DoD #1)", () => {
  it("equals sha256Json(value) when applied to the value's canonical bytes", () => {
    const value = { amount: 100, note: "wire transfer" };
    expect(contentAddress(canonicalBytes(value))).toBe(sha256Json(value));
  });
});

describe("encryptContent / decryptContent", () => {
  it("round-trips plaintext through AES-256-GCM", () => {
    const dek = generateDek();
    const plaintext = Buffer.from("full transaction description");
    const blob = encryptContent(plaintext, dek);
    expect(decryptContent(blob, dek).equals(plaintext)).toBe(true);
  });

  it("fails to decrypt on a tampered ciphertext (GCM auth failure)", () => {
    const dek = generateDek();
    const blob = encryptContent(Buffer.from("secret"), dek);
    const tampered = { ...blob, ciphertext: Buffer.from(blob.ciphertext, "hex").map((b, i) => (i === 0 ? b ^ 0xff : b)).toString("hex") };
    expect(() => decryptContent(tampered, dek)).toThrow();
  });

  it("fails to decrypt with the wrong DEK", () => {
    const blob = encryptContent(Buffer.from("secret"), generateDek());
    expect(() => decryptContent(blob, generateDek())).toThrow();
  });
});

describe("wrapDek / unwrapDek", () => {
  it("round-trips a DEK under a holder KEK", () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, holderKek);
    expect(Buffer.from(unwrapDek(wrapped, holderKek)).equals(Buffer.from(dek))).toBe(true);
  });

  it("fails to unwrap under the wrong KEK", () => {
    const wrapped = wrapDek(generateDek(), holderKek);
    expect(() => unwrapDek(wrapped, otherKek)).toThrow();
  });
});
