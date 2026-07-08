"""Delta #4 — CheckpointAgent integration (mocked notary, temp SQLite)."""

import sqlite3

import pytest

from app.checkpoint_agent import CheckpointAgent
from domain.heartbeat import GENESIS_HEARTBEAT_HASH, heartbeat_commitment, Heartbeat
from infra.db import SQLiteRepository


class FakeNotary:
    """Duck-typed stand-in for BlockchainNotary — records calls, no chain."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self._block = 1000

    def anchor(self, commitment_hex: str) -> dict:
        self.calls.append(commitment_hex)
        self._block += 1
        return {"tx_hash": "0x" + commitment_hex[:8], "block_number": self._block}


@pytest.fixture
def repo(tmp_path):
    path = str(tmp_path / "bank-b.db")
    # The `envelopes` table is created by the TS proxy in production; create it
    # here so the anchor can read the chain.
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE envelopes (
             id TEXT PRIMARY KEY, type TEXT, trace_id TEXT, raw_payload TEXT,
             signature TEXT, created_at TEXT, seq INTEGER, prev_hash TEXT)"""
    )
    conn.commit()
    conn.close()
    r = SQLiteRepository(path)
    yield r
    r.close()


def _seed_chain(repo: SQLiteRepository, count: int, start: int = 0) -> None:
    conn = repo._conn
    for i in range(start, start + count):
        prev = "0" * 64 if i == 0 else f"{i - 1:02x}" * 32
        conn.execute(
            "INSERT INTO envelopes (id, type, trace_id, raw_payload, signature, created_at, seq, prev_hash)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (f"id{i}", "INTENT", f"t{i}", "{}", f"sig{i}", f"2026-07-06T00:00:{i:02d}Z", i, prev),
        )
    conn.commit()


# ── checkpoint ────────────────────────────────────────────────────────────────

def test_empty_chain_is_a_noop(repo):
    notary = FakeNotary()
    result = CheckpointAgent(repo, notary, party="bank-b").anchor_checkpoint()
    assert result["status"] == "noop"
    assert notary.calls == []


def test_anchors_head_checkpoint_and_persists_it(repo):
    _seed_chain(repo, 3)
    notary = FakeNotary()
    agent = CheckpointAgent(repo, notary, party="bank-b")

    result = agent.anchor_checkpoint()

    assert result["status"] == "success"
    assert result["headSeq"] == 2
    assert result["rowCount"] == 3
    assert len(notary.calls) == 1
    assert notary.calls[0] == result["commitment"]

    saved = repo.get_latest_checkpoint("bank-b")
    assert saved["head_seq"] == 2
    assert saved["row_count"] == 3
    assert saved["status"] == "CONFIRMED"
    assert saved["tx_hash"] == result["txHash"]


def test_reanchoring_an_unchanged_head_is_a_noop(repo):
    _seed_chain(repo, 3)
    notary = FakeNotary()
    agent = CheckpointAgent(repo, notary, party="bank-b")

    agent.anchor_checkpoint()
    second = agent.anchor_checkpoint()

    assert second["status"] == "noop"
    assert len(notary.calls) == 1  # not called again


def test_advancing_the_chain_anchors_a_new_checkpoint(repo):
    _seed_chain(repo, 3)
    notary = FakeNotary()
    agent = CheckpointAgent(repo, notary, party="bank-b")
    agent.anchor_checkpoint()

    _seed_chain(repo, 2, start=3)  # now seq 0..4
    result = agent.anchor_checkpoint()

    assert result["status"] == "success"
    assert result["headSeq"] == 4
    assert result["rowCount"] == 5
    assert len(notary.calls) == 2
    assert len(repo.get_checkpoints("bank-b")) == 2


def test_refuses_to_anchor_a_chain_with_a_seq_gap(repo):
    _seed_chain(repo, 2)  # seq 0,1
    repo._conn.execute(
        "INSERT INTO envelopes (id, type, trace_id, raw_payload, signature, created_at, seq, prev_hash)"
        " VALUES (?,?,?,?,?,?,?,?)",
        ("id3", "INTENT", "t3", "{}", "sig3", "2026-07-06T00:00:03Z", 3, "aa" * 32),  # gap: seq 2 missing
    )
    repo._conn.commit()
    notary = FakeNotary()

    result = CheckpointAgent(repo, notary, party="bank-b").anchor_checkpoint()

    assert result["status"] == "error"
    assert notary.calls == []


# ── heartbeat ─────────────────────────────────────────────────────────────────

def test_first_heartbeat_is_seq_zero_from_genesis(repo):
    notary = FakeNotary()
    agent = CheckpointAgent(repo, notary, party="bank-b")

    result = agent.publish_heartbeat(timestamp="2026-07-06T00:00:00Z")

    assert result["status"] == "success"
    assert result["seq"] == 0
    assert len(notary.calls) == 1
    saved = repo.get_latest_heartbeat()
    assert saved["seq"] == 0
    assert saved["prev_hash"] == GENESIS_HEARTBEAT_HASH


def test_heartbeats_chain_and_increment(repo):
    notary = FakeNotary()
    agent = CheckpointAgent(repo, notary, party="bank-b")

    r0 = agent.publish_heartbeat(timestamp="2026-07-06T00:00:00Z")
    r1 = agent.publish_heartbeat(timestamp="2026-07-06T00:00:30Z")

    assert r1["seq"] == 1
    hb0 = Heartbeat(0, GENESIS_HEARTBEAT_HASH, "2026-07-06T00:00:00Z")
    saved = repo.get_heartbeats()
    assert [h["seq"] for h in saved] == [0, 1]
    assert saved[1]["prev_hash"] == heartbeat_commitment(hb0)
    assert r0["commitment"] != r1["commitment"]
