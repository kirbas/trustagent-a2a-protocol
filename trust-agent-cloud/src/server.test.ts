import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import request from "supertest";
import type { Express } from "express";
import {
  generateKeyPair,
  buildIntentEnvelope,
  buildAcceptanceReceipt,
  signEnvelope,
} from "@trustagentai/a2a-core";
import type { KeyPair } from "@trustagentai/a2a-core";
import { buildServer } from "./server.js";

const KEK = "b".repeat(64); // 32-byte hex, test-only

async function freshApp(): Promise<{ app: Express; witnessKey: KeyPair }> {
  const { app, witnessKey } = await buildServer({
    dbPath: join(tmpdir(), `cloud-server-test-${randomUUID()}.db`),
    keystorePath: join(tmpdir(), `cloud-server-keystore-${randomUUID()}.json`),
    keystoreKek: KEK,
  });
  return { app, witnessKey };
}

async function registeredHandshake(app: Express) {
  const proxyAKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
  const proxyBKey = await generateKeyPair("did:workload:bank-b-proxy#key-1");
  await request(app)
    .post("/register-key")
    .send({ kid: proxyAKey.kid, publicKeyHex: Buffer.from(proxyAKey.publicKey).toString("hex") })
    .expect(200);
  await request(app)
    .post("/register-key")
    .send({ kid: proxyBKey.kid, publicKeyHex: Buffer.from(proxyBKey.publicKey).toString("hex") })
    .expect(200);

  const { envelope: intent } = await buildIntentEnvelope({
    initiatorDid: "did:workload:bank-a-agent",
    vcRef: "vc:test",
    targetDid: "did:workload:bank-b-proxy",
    mcpDeploymentId: "did:workload:bank-b-proxy",
    toolName: "execute_wire_transfer",
    toolSchemaHash: "deadbeef",
    mcpSessionId: "sess-1",
    args: { amount: 100 },
    proxyKey: proxyAKey,
  });
  const acceptance = await buildAcceptanceReceipt({
    intentEnvelope: intent,
    policyEvalInput: { decision: "ACCEPTED" },
    proxyKey: proxyBKey,
  });
  return { intent, acceptance, proxyAKey, proxyBKey };
}

describe("GET /health", () => {
  it("reports ok and the witness kid", async () => {
    const { app, witnessKey } = await freshApp();
    const res = await request(app).get("/health").expect(200);
    expect(res.body).toEqual({ ok: true, witness_kid: witnessKey.kid });
  });
});

describe("POST /register-key", () => {
  it("registers a valid peer key", async () => {
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const res = await request(app)
      .post("/register-key")
      .send({ kid: key.kid, publicKeyHex: Buffer.from(key.publicKey).toString("hex") })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("400s when kid or publicKeyHex is missing", async () => {
    const { app } = await freshApp();
    const res = await request(app).post("/register-key").send({ kid: "x" }).expect(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("400s when endorsement is given without a timestamp", async () => {
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const res = await request(app)
      .post("/register-key")
      .send({
        kid: key.kid,
        publicKeyHex: Buffer.from(key.publicKey).toString("hex"),
        endorsement: { role: "proxy", kid: key.kid, signature: "x" },
      })
      .expect(400);
    expect(res.body.error).toMatch(/timestamp is required/);
  });

  it("400s when the service refuses the registration (rotating to a new kid with no endorsement)", async () => {
    const { app } = await freshApp();
    const oldKey = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    await request(app)
      .post("/register-key")
      .send({ kid: oldKey.kid, publicKeyHex: Buffer.from(oldKey.publicKey).toString("hex") })
      .expect(200);

    const newKey = await generateKeyPair("did:workload:bank-a-proxy#key-2");
    const res = await request(app)
      .post("/register-key")
      .send({ kid: newKey.kid, publicKeyHex: Buffer.from(newKey.publicKey).toString("hex") })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });
});

describe("POST /revoke-key", () => {
  it("400s when required fields are missing", async () => {
    const { app } = await freshApp();
    const res = await request(app).post("/revoke-key").send({}).expect(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("revokes a registered key given a valid self-endorsement", async () => {
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    await request(app)
      .post("/register-key")
      .send({ kid: key.kid, publicKeyHex: Buffer.from(key.publicKey).toString("hex") })
      .expect(200);

    const revokedAt = new Date().toISOString();
    const revokeAttestation = { did: "did:workload:bank-a-proxy", revoke_kid: key.kid, timestamp: revokedAt };
    const endorsement = await signEnvelope(revokeAttestation, key, "proxy");

    const res = await request(app)
      .post("/revoke-key")
      .send({ kid: key.kid, endorsement, timestamp: revokedAt })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("400s when the endorsement is invalid", async () => {
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    await request(app)
      .post("/register-key")
      .send({ kid: key.kid, publicKeyHex: Buffer.from(key.publicKey).toString("hex") })
      .expect(200);

    const res = await request(app)
      .post("/revoke-key")
      .send({ kid: key.kid, endorsement: { role: "proxy", kid: key.kid, signature: "bogus" }, timestamp: new Date().toISOString() })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });
});

describe("GET /key-history/:kid", () => {
  it("returns the rotation/revocation epoch history for a kid", async () => {
    const { app } = await freshApp();
    const key = await generateKeyPair("did:workload:bank-a-proxy#key-1");
    const hex = Buffer.from(key.publicKey).toString("hex");
    await request(app).post("/register-key").send({ kid: key.kid, publicKeyHex: hex }).expect(200);

    const res = await request(app).get(`/key-history/${key.kid}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ kid: key.kid, publicKeyHex: hex });
  });
});

describe("POST /co-sign", () => {
  it("400s when intent or acceptance is missing", async () => {
    const { app } = await freshApp();
    const res = await request(app).post("/co-sign").send({}).expect(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("co-signs a valid registered handshake", async () => {
    const { app } = await freshApp();
    const { intent, acceptance } = await registeredHandshake(app);

    const res = await request(app).post("/co-sign").send({ intent, acceptance }).expect(200);
    expect(res.body.cosign_receipt).toBeDefined();
    expect(res.body.seq).toBe(0);
    expect(res.body.idempotent).toBe(false);
  });

  it("400s when the handshake signatures don't verify", async () => {
    const { app } = await freshApp();
    const { intent, acceptance } = await registeredHandshake(app);
    const tampered = { ...intent, payload: { ...intent.payload, args_hash: "0".repeat(64) } };

    const res = await request(app).post("/co-sign").send({ intent: tampered, acceptance }).expect(400);
    expect(res.body.error).toBeDefined();
  });
});

describe("GET /verify-chain", () => {
  it("reports a valid empty chain, then stays valid after a co-sign", async () => {
    const { app } = await freshApp();
    expect((await request(app).get("/verify-chain").expect(200)).body.valid).toBe(true);

    const { intent, acceptance } = await registeredHandshake(app);
    await request(app).post("/co-sign").send({ intent, acceptance }).expect(200);

    expect((await request(app).get("/verify-chain").expect(200)).body.valid).toBe(true);
  });
});

describe("PUT/GET /blob/:contentHash", () => {
  const validBlob = {
    ciphertext: "aa",
    iv: "bb",
    tag: "cc",
    wrappedDeks: { "bank-a": { kek_kid: "bank-a-kek", wrapped_dek: "dd" } },
  };

  it("400s when required blob fields are missing", async () => {
    const { app } = await freshApp();
    const res = await request(app).put("/blob/hash1").send({ ciphertext: "aa" }).expect(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("stores a new blob (201) and reads it back", async () => {
    const { app } = await freshApp();
    const putRes = await request(app).put("/blob/hash1").send(validBlob).expect(201);
    expect(putRes.body).toEqual({ ok: true, created: true });

    const getRes = await request(app).get("/blob/hash1").expect(200);
    expect(getRes.body).toMatchObject(validBlob);
  });

  it("returns 200 (not created) on a write-once idempotent replay", async () => {
    const { app } = await freshApp();
    await request(app).put("/blob/hash1").send(validBlob).expect(201);
    const res = await request(app).put("/blob/hash1").send(validBlob).expect(200);
    expect(res.body).toEqual({ ok: true, created: false });
  });

  it("409s when the same contentHash is written with different content", async () => {
    const { app } = await freshApp();
    await request(app).put("/blob/hash1").send(validBlob).expect(201);
    const res = await request(app)
      .put("/blob/hash1")
      .send({ ...validBlob, ciphertext: "different" })
      .expect(409);
    expect(res.body.error).toBeDefined();
  });

  it("404s when the blob does not exist", async () => {
    const { app } = await freshApp();
    const res = await request(app).get("/blob/does-not-exist").expect(404);
    expect(res.body.error).toBe("blob not found");
  });
});

describe("POST /reset", () => {
  it("clears the co-sign chain and blob store", async () => {
    const { app } = await freshApp();
    const { intent, acceptance } = await registeredHandshake(app);
    await request(app).post("/co-sign").send({ intent, acceptance }).expect(200);
    await request(app)
      .put("/blob/hash1")
      .send({ ciphertext: "aa", iv: "bb", tag: "cc", wrappedDeks: { a: { kek_kid: "k", wrapped_dek: "d" } } })
      .expect(201);

    await request(app).post("/reset").expect(200);

    await request(app).get("/blob/hash1").expect(404);
    expect((await request(app).get("/verify-chain").expect(200)).body.valid).toBe(true);
  });
});
