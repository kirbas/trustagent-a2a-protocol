import json
import sqlite3
from typing import Optional

from domain.models import AnchorRecord, Envelope


class SQLiteRepository:
    """
    Reads from Bank-B proxy's SQLite database (shared via Docker volume).
    The 'envelopes' table is populated by the Bank-B TypeScript proxy.
    This service adds 'anchors' and 'anchor_leaves' tables for chain anchoring.
    """

    def __init__(self, db_path: str) -> None:
        self._conn = sqlite3.connect(db_path, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._init_anchor_schema()

    def _init_anchor_schema(self) -> None:
        """Create anchor-specific tables (envelopes table is managed by TS proxy)."""
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS anchors (
                batch_id     TEXT PRIMARY KEY,
                merkle_root  TEXT NOT NULL,
                tx_hash      TEXT,
                block_number INTEGER,
                status       TEXT NOT NULL DEFAULT 'PENDING',
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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

    # ── Read envelopes (populated by Bank-B TS proxy) ──────────────────────

    def get_unanchored_envelopes(self, limit: int = 50) -> list[Envelope]:
        """
        Get envelopes that haven't yet been included in an anchor batch.
        Excludes envelope IDs already present in anchor_leaves.
        """
        rows = self._conn.execute(
            """SELECT e.id, e.type, e.signature, e.trace_id AS payload_hash, e.created_at AS timestamp
               FROM envelopes e
               WHERE e.id NOT IN (SELECT envelope_id FROM anchor_leaves)
               ORDER BY e.created_at ASC
               LIMIT ?""",
            (limit,),
        ).fetchall()
        return [Envelope(
            id=row["id"],
            type=row["type"],
            signature=row["signature"],
            payload_hash=row["payload_hash"],
            timestamp=row["timestamp"],
        ) for row in rows]

    # ── Anchor CRUD ────────────────────────────────────────────────────────

    def save_anchor(self, record: AnchorRecord) -> None:
        import datetime
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self._conn.execute(
            """INSERT OR REPLACE INTO anchors (batch_id, merkle_root, tx_hash, block_number, status, created_at)
               VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM anchors WHERE batch_id = ?), ?))""",
            (record.batch_id, record.merkle_root, record.tx_hash, record.block_number, record.status, record.batch_id, now),
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
                      e.type AS envelope_type, e.created_at AS timestamp
               FROM anchor_leaves al
               LEFT JOIN envelopes e ON e.id = al.envelope_id
               WHERE al.batch_id = ?
               ORDER BY al.leaf_index ASC""",
            (batch_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def close(self) -> None:
        self._conn.close()
