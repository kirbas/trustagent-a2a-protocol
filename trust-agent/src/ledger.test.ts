import { describe, it, expect } from "vitest";
import {
  computeMerkleRoot,
  getMerkleProof,
  verifyMerkleProof,
  DAGLedger,
  type ArtifactEnvelope,
} from "./ledger.js";

function artifact(traceId: string, timestamp = new Date().toISOString()): ArtifactEnvelope {
  return {
    envelope_type: "IntentEnvelope",
    spec_version: "0.5",
    trace_id: traceId,
    timestamp,
    expires_at: new Date(Date.now() + 30_000).toISOString(),
    initiator: { did: "did:workload:agent#key-1", vc_ref: "urn:vc:1" },
    target: {
      did: "did:workload:bank-b#key-1",
      mcp_deployment_id: "deploy-1",
      tool_name: "transfer",
      tool_schema_hash: "hash",
      mcp_session_id: "session-1",
    },
    payload: { args_hash: "hash", nonce: "nonce" },
    signatures: [],
  } as ArtifactEnvelope;
}

describe("computeMerkleRoot", () => {
  it("throws on an empty leaf set", () => {
    expect(() => computeMerkleRoot([])).toThrow(/empty set/);
  });

  it("returns the single leaf as the root when there is only one leaf", () => {
    expect(computeMerkleRoot(["a"])).toBe("a");
  });

  it("is deterministic for the same leaves", () => {
    expect(computeMerkleRoot(["a", "b", "c"])).toBe(computeMerkleRoot(["a", "b", "c"]));
  });

  it("duplicates the last leaf when the leaf count is odd", () => {
    const odd = computeMerkleRoot(["a", "b", "c"]);
    const evenWithDup = computeMerkleRoot(["a", "b", "c", "c"]);
    expect(odd).toBe(evenWithDup);
  });

  it("changes when any leaf changes", () => {
    expect(computeMerkleRoot(["a", "b"])).not.toBe(computeMerkleRoot(["a", "x"]));
  });
});

describe("getMerkleProof / verifyMerkleProof", () => {
  it("produces a proof that verifies against the root for every leaf (even count)", () => {
    const leaves = ["a", "b", "c", "d"];
    const root = computeMerkleRoot(leaves);
    leaves.forEach((leaf, i) => {
      const proof = getMerkleProof(leaves, i);
      expect(verifyMerkleProof(leaf, proof, root)).toBe(true);
    });
  });

  it("produces a proof that verifies against the root for every leaf (odd count)", () => {
    const leaves = ["a", "b", "c"];
    const root = computeMerkleRoot(leaves);
    leaves.forEach((leaf, i) => {
      const proof = getMerkleProof(leaves, i);
      expect(verifyMerkleProof(leaf, proof, root)).toBe(true);
    });
  });

  it("fails verification for a tampered leaf", () => {
    const leaves = ["a", "b", "c", "d"];
    const root = computeMerkleRoot(leaves);
    const proof = getMerkleProof(leaves, 1);
    expect(verifyMerkleProof("tampered", proof, root)).toBe(false);
  });
});

describe("DAGLedger.append", () => {
  it("assigns sequential entry_id and stores the artifact", () => {
    const ledger = new DAGLedger();
    const e1 = ledger.append("INTENT_RECORD", artifact("trace-1"));
    const e2 = ledger.append("INTENT_RECORD", artifact("trace-2"));
    expect(e1.entry_id).toBe(1);
    expect(e2.entry_id).toBe(2);
    expect(e1.entry_hash).not.toBe(e2.entry_hash);
  });

  it("registers the entry in the timestamp registry by trace_id", () => {
    const ledger = new DAGLedger();
    ledger.append("INTENT_RECORD", artifact("trace-1"));
    const history = ledger.getHistory("trace-1");
    expect(history).toHaveLength(1);
    expect(history[0].event_type).toBe("INTENT_RECORD");
  });

  it("auto-commits a batch once batchSize entries have been appended", () => {
    const ledger = new DAGLedger(2);
    ledger.append("INTENT_RECORD", artifact("trace-1"));
    expect(ledger.getBatches()).toHaveLength(0);
    ledger.append("INTENT_RECORD", artifact("trace-2"));
    expect(ledger.getBatches()).toHaveLength(1);
    expect(ledger.getBatches()[0].entry_hashes).toHaveLength(2);
  });

  it("back-fills batch_id on entries and their timestamp records once batched", () => {
    const ledger = new DAGLedger(1);
    ledger.append("INTENT_RECORD", artifact("trace-1"));
    const [entry] = ledger.getAllEntries();
    expect(entry.batch_id).toBe(1);
    expect(ledger.getHistory("trace-1")[0].batch_id).toBe(1);
  });
});

describe("DAGLedger.flush", () => {
  it("returns null when there are no pending entries", () => {
    const ledger = new DAGLedger();
    expect(ledger.flush()).toBeNull();
  });

  it("commits a partial batch on manual flush", () => {
    const ledger = new DAGLedger(8);
    ledger.append("INTENT_RECORD", artifact("trace-1"));
    const batch = ledger.flush();
    expect(batch).not.toBeNull();
    expect(batch!.entry_hashes).toHaveLength(1);
    expect(ledger.getBatches()).toHaveLength(1);
  });
});

describe("DAGLedger.anchorBatch", () => {
  it("sets anchored_at on the matching batch", () => {
    const ledger = new DAGLedger(1);
    ledger.append("INTENT_RECORD", artifact("trace-1"));
    ledger.anchorBatch(1, "0xdeadbeef");
    expect(ledger.getBatches()[0].anchored_at).toBe("0xdeadbeef");
  });

  it("throws when the batch does not exist", () => {
    const ledger = new DAGLedger();
    expect(() => ledger.anchorBatch(999, "0xdeadbeef")).toThrow(/not found/);
  });
});

describe("DAGLedger.getDisputePack", () => {
  it("returns records, entries, and inclusion proofs for a batched trace", () => {
    const ledger = new DAGLedger(1);
    ledger.append("INTENT_RECORD", artifact("trace-1"));
    const pack = ledger.getDisputePack("trace-1");

    expect(pack.records).toHaveLength(1);
    expect(pack.entries).toHaveLength(1);
    expect(pack.inclusionProofs).toHaveLength(1);

    const { entry_hash, proof, batch } = pack.inclusionProofs[0];
    expect(verifyMerkleProof(entry_hash, proof, batch.merkle_root)).toBe(true);
  });

  it("omits inclusion proofs for entries not yet batched", () => {
    const ledger = new DAGLedger(8); // batch size 8, only 1 entry appended below
    ledger.append("INTENT_RECORD", artifact("trace-1"));
    const pack = ledger.getDisputePack("trace-1");
    expect(pack.entries).toHaveLength(1);
    expect(pack.inclusionProofs).toHaveLength(0);
  });

  it("returns empty results for an unknown trace_id", () => {
    const ledger = new DAGLedger();
    const pack = ledger.getDisputePack("unknown-trace");
    expect(pack.records).toEqual([]);
    expect(pack.entries).toEqual([]);
    expect(pack.inclusionProofs).toEqual([]);
  });
});

describe("DAGLedger.getAllEntries / getBatches", () => {
  it("return defensive copies, not the internal arrays", () => {
    const ledger = new DAGLedger();
    ledger.append("INTENT_RECORD", artifact("trace-1"));
    const entries = ledger.getAllEntries();
    entries.push({} as any);
    expect(ledger.getAllEntries()).toHaveLength(1);
  });
});
