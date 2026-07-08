import { describe, it, expect } from "vitest";
import { contentAddress } from "./worm.js";
import { buildWormRecord, decryptWormRecord, WormBlobStore } from "./worm-store.js";
import type { Holder } from "./worm-store.js";

const bankA: Holder = { id: "bank-a", kek: Buffer.from("1".repeat(64), "hex") };
const client: Holder = { id: "client", kek: Buffer.from("2".repeat(64), "hex") };
const witness: Holder = { id: "witness", kek: Buffer.from("3".repeat(64), "hex") };
const regulator: Holder = { id: "regulator", kek: Buffer.from("4".repeat(64), "hex") };

describe("buildWormRecord / decryptWormRecord", () => {
  it("addresses the record by sha256(plaintext) (DoD #1)", () => {
    const plaintext = Buffer.from(JSON.stringify({ amount: 250 }));
    const record = buildWormRecord(plaintext, [bankA, client, witness], regulator);
    expect(record.contentHash).toBe(contentAddress(plaintext));
  });

  it("lets every registered holder decrypt back the original plaintext", () => {
    const plaintext = Buffer.from("full transaction description");
    const record = buildWormRecord(plaintext, [bankA, client, witness], regulator);

    for (const holder of [bankA, client, witness]) {
      expect(decryptWormRecord(record, holder.id, holder.kek).equals(plaintext)).toBe(true);
    }
  });

  it("throws for a holder id that has no wrapped DEK on the record", () => {
    const record = buildWormRecord(Buffer.from("x"), [bankA], regulator);
    expect(() => decryptWormRecord(record, "client", client.kek)).toThrow();
  });

  it("lets the regulator unwrap the escrow entry but not the witness", () => {
    const plaintext = Buffer.from("dispute pack content");
    const record = buildWormRecord(plaintext, [bankA, client, witness], regulator);

    expect(decryptWormRecord(record, "regulator", regulator.kek).equals(plaintext)).toBe(true);
    // The witness's own KEK must not unlock the escrow entry (§5.4 — escrow is
    // NOT held by TrustAgentAI).
    expect(() => decryptWormRecord(record, "regulator", witness.kek)).toThrow();
  });
});

describe("WormBlobStore (write-once)", () => {
  const store = () => new WormBlobStore<{ v: string }>((r) => JSON.stringify(r));

  it("stores a new id and reports it as created", () => {
    const s = store();
    const { record, created } = s.put("id-1", { v: "a" });
    expect(created).toBe(true);
    expect(record).toEqual({ v: "a" });
    expect(s.get("id-1")).toEqual({ v: "a" });
  });

  it("is idempotent when the same id is written with byte-identical content", () => {
    const s = store();
    s.put("id-1", { v: "a" });
    const { record, created } = s.put("id-1", { v: "a" });
    expect(created).toBe(false);
    expect(record).toEqual({ v: "a" });
  });

  it("rejects writing different content under an already-used id", () => {
    const s = store();
    s.put("id-1", { v: "a" });
    expect(() => s.put("id-1", { v: "b" })).toThrow();
  });

  it("returns undefined for an id that was never written", () => {
    expect(store().get("missing")).toBeUndefined();
  });
});
