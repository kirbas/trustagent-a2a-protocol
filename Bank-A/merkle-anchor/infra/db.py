import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Optional

from domain.models import AnchorRecord, Envelope

ENVELOPE_TYPES = ["INTENT", "ACCEPTANCE", "EXECUTION", "PROVENANCE"]


class SQLiteRepository:
    def __init__(self, db_path: str) -> None:
        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        self.init_schema()

    def init_schema(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS envelopes (
                id           TEXT PRIMARY KEY,
                type         TEXT NOT NULL,
                signature    TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                timestamp    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS anchors (
                batch_id     TEXT PRIMARY KEY,
                merkle_root  TEXT NOT NULL,
                tx_hash      TEXT,
                block_number INTEGER,
                status       TEXT NOT NULL DEFAULT 'PENDING'
            );

            CREATE TABLE IF NOT EXISTS anchor_leaves (
                batch_id    TEXT NOT NULL,
                leaf_index  INTEGER NOT NULL,
                envelope_id TEXT NOT NULL,
                leaf_hash   TEXT NOT NULL,
                proof_path  TEXT NOT NULL,
                PRIMARY KEY (batch_id, leaf_index)
            );
        """)
        self._conn.commit()

    def seed_mock_envelopes(self, count: int = 10) -> None:
        existing = self._conn.execute("SELECT COUNT(*) FROM envelopes").fetchone()[0]
        if existing >= count:
            return

        rows = []
        for i in range(count):
            env_id = str(uuid.uuid4())
            env_type = ENVELOPE_TYPES[i % len(ENVELOPE_TYPES)]
            sig_seed = f"mock-sig-{i}-{env_id}"
            signature = hashlib.sha256(sig_seed.encode()).hexdigest() * 2
            payload = f"mock-payload-{i}-{env_id}"
            payload_hash = hashlib.sha256(payload.encode()).hexdigest()
            timestamp = datetime.now(timezone.utc).isoformat()
            rows.append((env_id, env_type, signature, payload_hash, timestamp))

        self._conn.executemany(
            "INSERT OR IGNORE INTO envelopes (id, type, signature, payload_hash, timestamp) VALUES (?,?,?,?,?)",
            rows,
        )
        self._conn.commit()

    def get_recent_envelopes(self, limit: int = 10) -> list[Envelope]:
        rows = self._conn.execute(
            "SELECT id, type, signature, payload_hash, timestamp FROM envelopes ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [Envelope(**dict(row)) for row in rows]

    def save_anchor(self, record: AnchorRecord) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO anchors (batch_id, merkle_root, tx_hash, block_number, status)
               VALUES (?, ?, ?, ?, ?)""",
            (record.batch_id, record.merkle_root, record.tx_hash, record.block_number, record.status),
        )
        self._conn.commit()

    def save_anchor_leaves(
        self, batch_id: str, envelopes: list[Envelope], leaves: list[dict]
    ) -> None:
        rows = [
            (batch_id, leaf["leaf_index"], envelopes[leaf["leaf_index"]].id,
             leaf["leaf_hash"], json.dumps(leaf["proof_path"]))
            for leaf in leaves
        ]
        self._conn.executemany(
            "INSERT OR IGNORE INTO anchor_leaves (batch_id, leaf_index, envelope_id, leaf_hash, proof_path) VALUES (?,?,?,?,?)",
            rows,
        )
        self._conn.commit()

    def get_anchor(self, batch_id: str) -> Optional[AnchorRecord]:
        row = self._conn.execute(
            "SELECT batch_id, merkle_root, tx_hash, block_number, status FROM anchors WHERE batch_id = ?",
            (batch_id,),
        ).fetchone()
        return AnchorRecord(**dict(row)) if row else None

    def get_anchor_by_tx_hash(self, tx_hash: str) -> Optional[AnchorRecord]:
        row = self._conn.execute(
            "SELECT batch_id, merkle_root, tx_hash, block_number, status FROM anchors WHERE tx_hash = ?",
            (tx_hash,),
        ).fetchone()
        return AnchorRecord(**dict(row)) if row else None

    def get_leaves_for_batch(self, batch_id: str) -> list[dict]:
        rows = self._conn.execute(
            """SELECT al.leaf_index, al.envelope_id, al.leaf_hash, al.proof_path,
                      e.type AS envelope_type, e.timestamp
               FROM anchor_leaves al
               LEFT JOIN envelopes e ON e.id = al.envelope_id
               WHERE al.batch_id = ?
               ORDER BY al.leaf_index ASC""",
            (batch_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def close(self) -> None:
        self._conn.close()
