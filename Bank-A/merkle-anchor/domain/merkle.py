import hashlib
from typing import TypedDict


def _sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


class ProofStep(TypedDict):
    hash: str
    position: str  # "left" | "right"


class LeafData(TypedDict):
    leaf_index: int
    leaf_hash: str
    proof_path: list[ProofStep]


def build_merkle_tree(signatures: list[str]) -> tuple[str, list[LeafData]]:
    """
    Build a Merkle tree from signatures.
    Returns (root_hex, leaves) where each leaf carries its Merkle inclusion proof.
    Bitcoin-style: odd-length levels duplicate the last node before hashing.
    """
    n = len(signatures)
    if n == 0:
        raise ValueError("Cannot build Merkle tree: signatures list is empty")

    # Build padded levels so proof paths can reference correct siblings
    levels: list[list[bytes]] = []
    current: list[bytes] = [_sha256(sig.encode()) for sig in signatures]

    while len(current) > 1:
        if len(current) % 2 == 1:
            current = current + [current[-1]]   # duplicate last (Bitcoin-style)
        levels.append(current)
        current = [_sha256(current[i] + current[i + 1]) for i in range(0, len(current), 2)]
    levels.append(current)  # root level

    root = levels[-1][0].hex()

    leaves: list[LeafData] = []
    for i in range(n):
        proof_path: list[ProofStep] = []
        idx = i
        for lvl in range(len(levels) - 1):
            level = levels[lvl]
            if idx % 2 == 0:
                proof_path.append({"hash": level[idx + 1].hex(), "position": "right"})
            else:
                proof_path.append({"hash": level[idx - 1].hex(), "position": "left"})
            idx //= 2
        leaves.append({"leaf_index": i, "leaf_hash": levels[0][i].hex(), "proof_path": proof_path})

    return root, leaves


def verify_proof(leaf_hash: str, proof_path: list[ProofStep], expected_root: str) -> bool:
    """Verify a Merkle inclusion proof. Returns True if leaf is in the tree."""
    current = bytes.fromhex(leaf_hash)
    for step in proof_path:
        sibling = bytes.fromhex(step["hash"])
        if step["position"] == "right":
            current = _sha256(current + sibling)
        else:
            current = _sha256(sibling + current)
    return current.hex() == expected_root


def compute_merkle_root(signatures: list[str]) -> str:
    """Root only — delegates to build_merkle_tree."""
    root, _ = build_merkle_tree(signatures)
    return root
