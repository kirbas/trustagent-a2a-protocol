import uuid
import sys

from domain.merkle import build_merkle_tree, verify_proof
from domain.models import AnchorRecord
from infra.db import SQLiteRepository
from infra.notary import BlockchainNotary

BASESCAN_TX_URL = "https://sepolia.basescan.org/tx/0x{tx_hash}"
BATCH_SIZE = 50  # Anchor up to 50 envelopes at a time


class AccountingAgent:
    def __init__(self, db: SQLiteRepository, notary: BlockchainNotary) -> None:
        self._db = db
        self._notary = notary

    def _log(self, message: str) -> None:
        print(f"[AccountingAgent - Proxy B] {message}", file=sys.stdout)

    def anchor_pending_envelopes(self) -> dict:
        """
        Gathers unanchored envelopes, computes the Merkle root,
        and anchors to Base Sepolia.
        Returns a dict with txHash, blockNumber, basescanUrl.
        """
        self._log("Waking up. Scanning local ledger...")

        envelopes = self._db.get_unanchored_envelopes(limit=BATCH_SIZE)
        if not envelopes:
            self._log("No unanchored envelopes found. Nothing to do.")
            return {"status": "noop", "message": "No unanchored envelopes found"}

        self._log(f"I am aggregating {len(envelopes)} receipts into a tamper-evident root.")

        signatures = [e.signature for e in envelopes]
        merkle_root, leaves = build_merkle_tree(signatures)
        self._log(f"Merkle root computed: 0x{merkle_root}")
        self._log(f"Tree: {len(leaves)} leaves, {len(leaves[0]['proof_path'])} proof steps per leaf")

        batch_id = str(uuid.uuid4())
        pending = AnchorRecord(batch_id=batch_id, merkle_root=merkle_root, status="PENDING")
        self._db.save_anchor(pending)

        self._log(f"Ed25519-signed envelopes collected. Building SHA-256 Merkle tree over {len(envelopes)} signatures for dispute-grade inclusion proofs.")
        self._log("Broadcasting 0-ETH self-transaction with Merkle root to Base Sepolia (chain 84532)...")

        try:
            result = self._notary.anchor(merkle_root)
        except Exception as exc:
            self._log(f"Anchor failed: {exc}")
            self._db.save_anchor(AnchorRecord(batch_id=batch_id, merkle_root=merkle_root, status="FAILED"))
            raise

        self._db.save_anchor(AnchorRecord(
            batch_id=batch_id,
            merkle_root=merkle_root,
            tx_hash=result["tx_hash"],
            block_number=result["block_number"],
            status="CONFIRMED",
        ))
        self._db.save_anchor_leaves(batch_id, envelopes, leaves)

        all_valid = all(
            verify_proof(leaf["leaf_hash"], leaf["proof_path"], merkle_root)
            for leaf in leaves
        )

        self._log(
            f"Anchor confirmed at block {result['block_number']}. All {len(envelopes)} envelopes cryptographically bound to L2. Local proof re-verified: all_valid={all_valid}."
        )

        vc_link = BASESCAN_TX_URL.format(tx_hash=result["tx_hash"])
        self._log(f"VC Pitch Link → {vc_link}")

        return {
            "status": "success",
            "txHash": result["tx_hash"],
            "blockNumber": result["block_number"],
            "merkleRoot": merkle_root,
            "basescanUrl": vc_link,
            "traceIds": [e.payload_hash for e in envelopes]
        }
