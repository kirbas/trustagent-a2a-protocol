import os
import sys

from dotenv import find_dotenv, load_dotenv
from flask import Flask, jsonify

from app.accounting_agent import AccountingAgent
from infra.db import SQLiteRepository
from infra.notary import BlockchainNotary

load_dotenv(find_dotenv())

app = Flask(__name__)

def _require_env(key: str) -> str:
    value = os.getenv(key)
    if not value:
        print(f"ERROR: Missing required environment variable: {key}", file=sys.stderr)
        sys.exit(1)
    return value


@app.route('/anchor', methods=['POST'])
def trigger_anchor():
    rpc_url = _require_env("RPC_URL")
    private_key = _require_env("PRIVATE_KEY")
    db_path = os.getenv("DB_PATH", "/data/bank-b.db")

    db = SQLiteRepository(db_path)
    notary = BlockchainNotary(rpc_url=rpc_url, private_key=private_key)

    if not notary.is_connected:
        db.close()
        return jsonify({"error": f"Cannot connect to RPC at {rpc_url}"}), 500

    agent = AccountingAgent(db=db, notary=notary)
    try:
        result = agent.anchor_pending_envelopes()
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
