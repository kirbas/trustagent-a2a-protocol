import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import type { IntentEnvelope, AcceptanceEnvelope, ExecutionEnvelope } from "./types.js";

export class Ledger {
  private db: Database.Database;
  private proxyKey: string;

  constructor(dbPath: string, proxyKey: string) {
    this.db = new Database(dbPath, { timeout: 5000 });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.proxyKey = proxyKey;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        signature TEXT NOT NULL,
        prev_hash TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  append(type: string, payload: IntentEnvelope | AcceptanceEnvelope | ExecutionEnvelope, prevHashes: string[]): string {
    const id = randomUUID();
    const traceId = (payload as any).trace_id || randomUUID();
    const prevHash = prevHashes.length > 0 ? prevHashes[prevHashes.length - 1] : null;
    const now = new Date().toISOString();

    const hash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");

    this.db.prepare(
      "INSERT INTO entries (id, type, trace_id, payload, signature, prev_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, type, traceId, JSON.stringify(payload), hash, prevHash, now);

    return hash;
  }

  getDisputePack(traceId: string) {
    const entries = this.db.prepare(
      "SELECT * FROM entries WHERE trace_id = ? ORDER BY created_at ASC"
    ).all(traceId) as any[];

    const records = entries.map(e => ({
      trace_id: e.trace_id,
      event_type: e.type,
      entry_hash: e.id,
      timestamp: e.created_at,
    }));

    const entriesWithProofs = entries.map(e => {
      const proof = e.prev_hash ? { sibling: e.prev_hash } : null;
      return {
        trace_id: e.trace_id,
        event_type: e.type,
        artifact: JSON.parse(e.payload),
        entry_hash: e.id,
        inclusionProof: proof,
      };
    });

    return { records, entries: entriesWithProofs };
  }
}
