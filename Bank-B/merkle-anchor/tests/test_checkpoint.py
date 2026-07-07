"""Delta #4 — per-party chain HEAD checkpoint (pure logic)."""

from domain.checkpoint import (
    Checkpoint,
    build_checkpoint,
    checkpoint_commitment,
    is_contiguous,
)

GENESIS = "0" * 64


def _row(seq: int, prev_hash: str) -> dict:
    return {"seq": seq, "prev_hash": prev_hash}


def test_build_checkpoint_returns_none_for_empty_chain():
    assert build_checkpoint("bank-b", []) is None


def test_build_checkpoint_pins_head_seq_prev_hash_and_count():
    rows = [_row(0, GENESIS), _row(1, "aa" * 32), _row(2, "bb" * 32)]
    cp = build_checkpoint("bank-b", rows)
    assert cp == Checkpoint(party="bank-b", head_seq=2, head_prev_hash="bb" * 32, row_count=3)


def test_commitment_is_32_byte_hex_and_deterministic():
    cp = Checkpoint(party="bank-b", head_seq=2, head_prev_hash="bb" * 32, row_count=3)
    c1 = checkpoint_commitment(cp)
    c2 = checkpoint_commitment(cp)
    assert c1 == c2
    assert len(c1) == 64
    int(c1, 16)  # valid hex


def test_commitment_changes_when_head_advances():
    a = Checkpoint("bank-b", 2, "bb" * 32, 3)
    b = Checkpoint("bank-b", 3, "cc" * 32, 4)
    assert checkpoint_commitment(a) != checkpoint_commitment(b)


def test_commitment_is_party_scoped():
    a = Checkpoint("bank-b", 2, "bb" * 32, 3)
    b = Checkpoint("witness", 2, "bb" * 32, 3)
    assert checkpoint_commitment(a) != checkpoint_commitment(b)


def test_is_contiguous_true_for_gapless_zero_based_sequence():
    rows = [_row(0, GENESIS), _row(1, "aa" * 32), _row(2, "bb" * 32)]
    assert is_contiguous(rows) is True


def test_is_contiguous_false_on_seq_gap():
    rows = [_row(0, GENESIS), _row(2, "bb" * 32)]  # missing seq 1
    assert is_contiguous(rows) is False


def test_is_contiguous_true_for_empty():
    assert is_contiguous([]) is True
