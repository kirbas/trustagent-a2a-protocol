"""
Delta #4 — per-party chain HEAD checkpoint.

Each party (a bank's `envelopes` chain, the witness's `cosigns` chain) is an
append-only hash-chain (`seq` + `prev_hash`, Deltas #2/#3). A *checkpoint* pins
that chain's HEAD position — `(party, head_seq, head_prev_hash, row_count)` — and
its 32-byte commitment is anchored on Base Sepolia.

Per the defense-in-depth map (DISPUTE_HARDENING §4), checkpoints + heartbeat
close *"when"* — monotonic public time and ordering that cannot be rewound.
Tamper-evidence of *content* is the hash-chain's job, so the checkpoint commits
only to fields already stored in the chain (no row-hash recomputation needed).
"""

import hashlib
from dataclasses import dataclass
from typing import Any, Optional, Sequence


@dataclass(frozen=True)
class Checkpoint:
    party: str
    head_seq: int
    head_prev_hash: str
    row_count: int


def _seq(row: Any) -> int:
    return row["seq"] if isinstance(row, dict) else row.seq


def _prev_hash(row: Any) -> str:
    return row["prev_hash"] if isinstance(row, dict) else row.prev_hash


def build_checkpoint(party: str, rows: Sequence[Any]) -> Optional[Checkpoint]:
    """
    Build a HEAD checkpoint from chain rows ordered by ``seq`` ascending.
    Returns ``None`` for an empty chain (nothing to anchor).
    """
    if not rows:
        return None
    head = rows[-1]
    return Checkpoint(
        party=party,
        head_seq=_seq(head),
        head_prev_hash=_prev_hash(head),
        row_count=len(rows),
    )


def checkpoint_commitment(cp: Checkpoint) -> str:
    """Deterministic 32-byte (hex) SHA-256 commitment anchored on-chain."""
    payload = f"checkpoint|{cp.party}|{cp.head_seq}|{cp.head_prev_hash}|{cp.row_count}"
    return hashlib.sha256(payload.encode()).hexdigest()


def is_contiguous(rows: Sequence[Any]) -> bool:
    """
    True when ``seq`` values form a gapless zero-based run (0, 1, 2, …). A gap
    means a row was deleted between checkpoints — the anchor must not certify a
    broken chain. An empty chain is vacuously contiguous.
    """
    return all(_seq(row) == i for i, row in enumerate(rows))
