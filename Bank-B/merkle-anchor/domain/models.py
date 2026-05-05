from dataclasses import dataclass
from typing import Optional


@dataclass
class Envelope:
    id: str
    type: str
    signature: str
    payload_hash: str
    timestamp: str


@dataclass
class AnchorRecord:
    batch_id: str
    merkle_root: str
    status: str
    tx_hash: Optional[str] = None
    block_number: Optional[int] = None
