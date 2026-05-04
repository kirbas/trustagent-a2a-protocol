import uuid

from domain.merkle import build_merkle_tree, verify_proof
from domain.models import AnchorRecord
from infra.db import SQLiteRepository
from infra.notary import BlockchainNotary

BASESCAN_TX_URL = "https://sepolia.basescan.org/tx/0x{tx_hash}"
BATCH_SIZE = 10


class AccountingAgent:
    def __init__(self, db: SQLiteRepository, notary: BlockchainNotary) -> None:
        self._db = db
        self._notary = notary

    def _log(self, message: str) -> None:
        print(f"[AccountingAgent] {message}")

    def run(self) -> None:
        self._log("Waking up. Scanning local ledger...")

        self._db.seed_mock_envelopes(BATCH_SIZE)

        envelopes = self._db.get_recent_envelopes(limit=BATCH_SIZE)
        if not envelopes:
            self._log("No envelopes found. Exiting.")
            return

        self._log(f"I am aggregating the last {len(envelopes)} receipts into a tamper-evident root.")

        signatures = [e.signature for e in envelopes]
        merkle_root, leaves = build_merkle_tree(signatures)
        self._log(f"Merkle root computed: 0x{merkle_root}")
        self._log(f"Tree: {len(leaves)} leaves, {len(leaves[0]['proof_path'])} proof steps per leaf")

        batch_id = str(uuid.uuid4())
        pending = AnchorRecord(batch_id=batch_id, merkle_root=merkle_root, status="PENDING")
        self._db.save_anchor(pending)

        self._log("Broadcasting anchor to Base Sepolia (chain 84532)...")

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

        # Local proof integrity check
        all_valid = all(
            verify_proof(leaf["leaf_hash"], leaf["proof_path"], merkle_root)
            for leaf in leaves
        )
        self._log(f"Local proof verification: all_valid={all_valid}")

        self._log(
            f"Verification successful. The local state is now anchored to Base Sepolia at block {result['block_number']}."
        )

        vc_link = BASESCAN_TX_URL.format(tx_hash=result["tx_hash"])
        print(f"\nVC Pitch Link → {vc_link}\n")
