"""
Delta #4 — CheckpointAgent.

Anchors the per-party chain HEAD checkpoint (not an arbitrary signature batch)
and publishes the periodic on-chain heartbeat. The notary is duck-typed (any
object with ``anchor(commitment_hex) -> {tx_hash, block_number}``) so this agent
is testable without a live chain or web3.
"""

import sys
from datetime import datetime, timezone

from domain.checkpoint import build_checkpoint, checkpoint_commitment, is_contiguous
from domain.heartbeat import Heartbeat, heartbeat_commitment, next_heartbeat


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CheckpointAgent:
    def __init__(self, db, notary, party: str = "bank-b") -> None:
        self._db = db
        self._notary = notary
        self._party = party

    def _log(self, message: str) -> None:
        print(f"[CheckpointAgent - {self._party}] {message}", file=sys.stdout)

    def anchor_checkpoint(self) -> dict:
        """
        Read the party's chain, build its HEAD checkpoint, and anchor the
        commitment on-chain. No-op when the chain is empty or its HEAD is
        unchanged since the last checkpoint; refuses to anchor a chain with a
        ``seq`` gap (a deletion must not be silently certified).
        """
        rows = self._db.get_chain_rows()
        checkpoint = build_checkpoint(self._party, rows)
        if checkpoint is None:
            self._log("chain is empty — nothing to checkpoint")
            return {"status": "noop", "message": "chain is empty"}

        if not is_contiguous(rows):
            self._log("REFUSING to anchor: chain has a seq gap (deletion suspected)")
            return {"status": "error", "message": "chain has a seq gap; not anchoring"}

        commitment = checkpoint_commitment(checkpoint)
        last = self._db.get_latest_checkpoint(self._party)
        if last and last["commitment"] == commitment:
            self._log(f"HEAD unchanged at seq {checkpoint.head_seq} — no new anchor")
            return {
                "status": "noop",
                "message": "head unchanged",
                "headSeq": checkpoint.head_seq,
                "commitment": commitment,
            }

        self._log(
            f"anchoring HEAD checkpoint: seq={checkpoint.head_seq} rows={checkpoint.row_count}"
        )
        result = self._notary.anchor(commitment)
        self._db.save_checkpoint(
            {
                "party": checkpoint.party,
                "head_seq": checkpoint.head_seq,
                "head_prev_hash": checkpoint.head_prev_hash,
                "row_count": checkpoint.row_count,
                "commitment": commitment,
                "tx_hash": result["tx_hash"],
                "block_number": result["block_number"],
                "status": "CONFIRMED",
            }
        )
        self._log(f"checkpoint anchored at block {result['block_number']}")
        return {
            "status": "success",
            "party": checkpoint.party,
            "headSeq": checkpoint.head_seq,
            "rowCount": checkpoint.row_count,
            "commitment": commitment,
            "txHash": result["tx_hash"],
            "blockNumber": result["block_number"],
        }

    def publish_heartbeat(self, timestamp: str | None = None) -> dict:
        """
        Publish the next heartbeat: a monotonic, self-chaining commitment sent
        on-chain from the anchor wallet. A gap in the resulting seq/time series
        is the public signal that the anchor was down (Delta #7 input).
        """
        ts = timestamp or _now_iso()
        last_row = self._db.get_latest_heartbeat()
        last = (
            Heartbeat(last_row["seq"], last_row["prev_hash"], last_row["timestamp"])
            if last_row
            else None
        )
        heartbeat = next_heartbeat(last, ts)
        commitment = heartbeat_commitment(heartbeat)

        self._log(f"publishing heartbeat seq={heartbeat.seq}")
        result = self._notary.anchor(commitment)
        self._db.save_heartbeat(
            {
                "seq": heartbeat.seq,
                "prev_hash": heartbeat.prev_hash,
                "commitment": commitment,
                "timestamp": heartbeat.timestamp,
                "tx_hash": result["tx_hash"],
                "block_number": result["block_number"],
                "status": "CONFIRMED",
            }
        )
        return {
            "status": "success",
            "seq": heartbeat.seq,
            "commitment": commitment,
            "txHash": result["tx_hash"],
            "blockNumber": result["block_number"],
        }
