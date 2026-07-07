"""
Delta #4 — signed on-chain heartbeat.

The anchor publishes a periodic heartbeat: a 0-ETH self-transaction whose data
field carries a monotonic, self-chaining commitment ``(seq, prev_hash,
timestamp)``. Because every heartbeat is sent from the anchor's known wallet
address, its authenticity is the transaction signature itself; because they
chain (each ``prev_hash`` = the previous heartbeat's commitment) and increment
``seq``, a missing beat leaves a provable gap.

A heartbeat gap is the public signal that the witness / anchor was unavailable —
the input Delta #7 (degraded-mode discipline) reconciles against.
"""

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Sequence

GENESIS_HEARTBEAT_HASH = "0" * 64


@dataclass(frozen=True)
class Heartbeat:
    seq: int
    prev_hash: str
    timestamp: str  # ISO-8601 (UTC)


def heartbeat_commitment(hb: Heartbeat) -> str:
    """Deterministic 32-byte (hex) SHA-256 commitment anchored on-chain."""
    payload = f"heartbeat|{hb.seq}|{hb.prev_hash}|{hb.timestamp}"
    return hashlib.sha256(payload.encode()).hexdigest()


def next_heartbeat(last: Optional[Heartbeat], timestamp: str) -> Heartbeat:
    """Build the next heartbeat, chaining it to ``last`` (or genesis if first)."""
    if last is None:
        return Heartbeat(seq=0, prev_hash=GENESIS_HEARTBEAT_HASH, timestamp=timestamp)
    return Heartbeat(seq=last.seq + 1, prev_hash=heartbeat_commitment(last), timestamp=timestamp)


def _parse(ts: str) -> datetime:
    # datetime.fromisoformat on Python 3.10 does not accept a trailing "Z".
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def find_heartbeat_gaps(
    heartbeats: Sequence[Heartbeat], max_interval_seconds: float
) -> list[dict]:
    """
    Return gaps where consecutive heartbeats are further apart in time than
    ``max_interval_seconds``. Each gap is ``{"after_seq", "gap_seconds"}``.
    Heartbeats are assumed ordered by ``seq`` ascending.
    """
    gaps: list[dict] = []
    for prev, curr in zip(heartbeats, heartbeats[1:]):
        delta = (_parse(curr.timestamp) - _parse(prev.timestamp)).total_seconds()
        if delta > max_interval_seconds:
            gaps.append({"after_seq": prev.seq, "gap_seconds": delta})
    return gaps
