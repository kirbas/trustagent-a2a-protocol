from eth_account import Account
from web3 import Web3

BASE_SEPOLIA_CHAIN_ID = 84532
# 21000 base gas + 68 gas per non-zero data byte * 32 bytes for Merkle root
_GAS_LIMIT = 21_000 + (68 * 32)


class BlockchainNotary:
    def __init__(self, rpc_url: str, private_key: str) -> None:
        self._w3 = Web3(Web3.HTTPProvider(rpc_url))
        self._private_key = private_key
        self._address = Account.from_key(private_key).address

    @property
    def is_connected(self) -> bool:
        return self._w3.is_connected()

    def anchor(self, merkle_root: str) -> dict:
        """
        Send a 0-ETH self-transaction with the Merkle root in the data field.
        Returns tx_hash and block_number on confirmation.
        """
        if not self._w3.is_connected():
            raise ConnectionError("Cannot connect to RPC endpoint")

        nonce = self._w3.eth.get_transaction_count(self._address)
        block = self._w3.eth.get_block("latest")
        base_fee = block["baseFeePerGas"]
        priority_fee = self._w3.to_wei(1, "gwei")

        tx = {
            "nonce": nonce,
            "to": self._address,
            "from": self._address,
            "value": 0,
            "data": "0x" + merkle_root,
            "chainId": BASE_SEPOLIA_CHAIN_ID,
            "gas": _GAS_LIMIT,
            "maxFeePerGas": base_fee * 2 + priority_fee,
            "maxPriorityFeePerGas": priority_fee,
            "type": 2,
        }

        signed = self._w3.eth.account.sign_transaction(tx, self._private_key)
        raw_tx_hash = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self._w3.eth.wait_for_transaction_receipt(raw_tx_hash, timeout=120)

        return {
            "tx_hash": receipt.transactionHash.hex(),
            "block_number": receipt.blockNumber,
        }
