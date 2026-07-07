"""Delta #4 — signed on-chain heartbeat chain (pure logic)."""

from domain.heartbeat import (
    GENESIS_HEARTBEAT_HASH,
    Heartbeat,
    find_heartbeat_gaps,
    heartbeat_commitment,
    next_heartbeat,
)


def test_first_heartbeat_starts_at_seq_zero_from_genesis():
    hb = next_heartbeat(None, "2026-07-06T00:00:00Z")
    assert hb.seq == 0
    assert hb.prev_hash == GENESIS_HEARTBEAT_HASH
    assert hb.timestamp == "2026-07-06T00:00:00Z"


def test_next_heartbeat_increments_seq_and_links_prev_hash():
    hb0 = next_heartbeat(None, "2026-07-06T00:00:00Z")
    hb1 = next_heartbeat(hb0, "2026-07-06T00:00:30Z")
    assert hb1.seq == 1
    assert hb1.prev_hash == heartbeat_commitment(hb0)


def test_commitment_is_32_byte_hex_and_deterministic():
    hb = Heartbeat(seq=0, prev_hash=GENESIS_HEARTBEAT_HASH, timestamp="2026-07-06T00:00:00Z")
    c1 = heartbeat_commitment(hb)
    c2 = heartbeat_commitment(hb)
    assert c1 == c2
    assert len(c1) == 64
    int(c1, 16)


def test_commitment_changes_with_timestamp():
    a = Heartbeat(0, GENESIS_HEARTBEAT_HASH, "2026-07-06T00:00:00Z")
    b = Heartbeat(0, GENESIS_HEARTBEAT_HASH, "2026-07-06T00:00:30Z")
    assert heartbeat_commitment(a) != heartbeat_commitment(b)


def test_no_gaps_when_heartbeats_are_within_interval():
    hbs = [
        Heartbeat(0, GENESIS_HEARTBEAT_HASH, "2026-07-06T00:00:00Z"),
        Heartbeat(1, "x", "2026-07-06T00:00:30Z"),
        Heartbeat(2, "y", "2026-07-06T00:01:00Z"),
    ]
    assert find_heartbeat_gaps(hbs, max_interval_seconds=60) == []


def test_detects_gap_when_interval_exceeded():
    hbs = [
        Heartbeat(0, GENESIS_HEARTBEAT_HASH, "2026-07-06T00:00:00Z"),
        Heartbeat(1, "x", "2026-07-06T00:05:00Z"),  # 300s gap
    ]
    gaps = find_heartbeat_gaps(hbs, max_interval_seconds=60)
    assert len(gaps) == 1
    assert gaps[0]["after_seq"] == 0
    assert gaps[0]["gap_seconds"] == 300.0


def test_no_gaps_for_single_or_empty_series():
    assert find_heartbeat_gaps([], 60) == []
    assert find_heartbeat_gaps([Heartbeat(0, GENESIS_HEARTBEAT_HASH, "2026-07-06T00:00:00Z")], 60) == []
