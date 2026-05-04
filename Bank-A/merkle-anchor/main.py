import os
import sys

from dotenv import find_dotenv, load_dotenv

from app.accounting_agent import AccountingAgent
from infra.db import SQLiteRepository
from infra.notary import BlockchainNotary

load_dotenv(find_dotenv())


def _require_env(key: str) -> str:
    value = os.getenv(key)
    if not value:
        print(f"ERROR: Missing required environment variable: {key}", file=sys.stderr)
        sys.exit(1)
    return value


def main() -> None:
    rpc_url = _require_env("RPC_URL")
    private_key = _require_env("PRIVATE_KEY")
    db_path = os.getenv("DB_PATH", "./ledger.db")

    db = SQLiteRepository(db_path)
    notary = BlockchainNotary(rpc_url=rpc_url, private_key=private_key)

    if not notary.is_connected:
        print(f"ERROR: Cannot connect to RPC at {rpc_url}", file=sys.stderr)
        db.close()
        sys.exit(1)

    agent = AccountingAgent(db=db, notary=notary)
    try:
        agent.run()
    finally:
        db.close()


if __name__ == "__main__":
    main()
