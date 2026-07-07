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

            -- Delta #4: per-party chain HEAD checkpoints
            CREATE TABLE IF NOT EXISTS checkpoints (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                party          TEXT NOT NULL,
                head_seq       INTEGER NOT NULL,
                head_prev_hash TEXT NOT NULL,
                row_count      INTEGER NOT NULL,
                commitment     TEXT NOT NULL,
                tx_hash        TEXT,
                block_number   INTEGER,
                status         TEXT NOT NULL DEFAULT 'PENDING',
                created_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Delta #4: monotonic on-chain heartbeat chain
            CREATE TABLE IF NOT EXISTS heartbeats (
                seq          INTEGER PRIMARY KEY,
                prev_hash    TEXT NOT NULL,
                commitment   TEXT NOT NULL,
                timestamp    TEXT NOT NULL,
                tx_hash      TEXT,
                block_number INTEGER,
                status       TEXT NOT NULL DEFAULT 'PENDING',
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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

    # ── Delta #4: chain HEAD checkpoints + heartbeats ──────────────────────

    def get_chain_rows(self) -> list[dict]:
        """
        The party's append-only hash-chain rows (seq + prev_hash), ordered by
        ``seq``. Reads the `envelopes` table the TS proxy links (Delta #2).
        """
        rows = self._conn.execute(
            """SELECT id, type, trace_id, seq, prev_hash, created_at
               FROM envelopes
               WHERE seq IS NOT NULL
               ORDER BY seq ASC"""
        ).fetchall()
        return [dict(r) for r in rows]

    def _now_iso(self) -> str:
        import datetime
        return datetime.datetime.now(datetime.timezone.utc).isoformat()

    def save_checkpoint(self, record: dict) -> None:
        self._conn.execute(
            """INSERT INTO checkpoints
               (party, head_seq, head_prev_hash, row_count, commitment, tx_hash, block_number, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                record["party"], record["head_seq"], record["head_prev_hash"],
                record["row_count"], record["commitment"], record.get("tx_hash"),
                record.get("block_number"), record.get("status", "PENDING"), self._now_iso(),
            ),
        )
        self._conn.commit()

    def get_latest_checkpoint(self, party: str) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT * FROM checkpoints WHERE party = ? ORDER BY head_seq DESC, id DESC LIMIT 1",
            (party,),
        ).fetchone()
        return dict(row) if row else None

    def get_checkpoints(self, party: Optional[str] = None) -> list[dict]:
        if party is None:
            rows = self._conn.execute("SELECT * FROM checkpoints ORDER BY id ASC").fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM checkpoints WHERE party = ? ORDER BY id ASC", (party,)
            ).fetchall()
        return [dict(r) for r in rows]

    def save_heartbeat(self, record: dict) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO heartbeats
               (seq, prev_hash, commitment, timestamp, tx_hash, block_number, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                record["seq"], record["prev_hash"], record["commitment"], record["timestamp"],
                record.get("tx_hash"), record.get("block_number"),
                record.get("status", "PENDING"), self._now_iso(),
            ),
        )
        self._conn.commit()

    def get_latest_heartbeat(self) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT * FROM heartbeats ORDER BY seq DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

    def get_heartbeats(self) -> list[dict]:
        rows = self._conn.execute("SELECT * FROM heartbeats ORDER BY seq ASC").fetchall()
        return [dict(r) for r in rows]

    def close(self) -> None:
        self._conn.close()
