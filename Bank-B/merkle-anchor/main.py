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


import threading

_anchor_lock = threading.Lock()

@app.route('/anchor', methods=['POST'])
def trigger_anchor():
    if not _anchor_lock.acquire(blocking=False):
        return jsonify({"status": "noop", "message": "Anchor already in progress"}), 200

    rpc_url = os.getenv("RPC_URL")
    private_key = os.getenv("PRIVATE_KEY")
    if not rpc_url or not private_key:
        _anchor_lock.release()
        return jsonify({"error": "RPC_URL and PRIVATE_KEY must be set"}), 500

    db_path = os.getenv("DB_PATH", "/data/bank-b.db")
    db = SQLiteRepository(db_path)
    notary = BlockchainNotary(rpc_url=rpc_url, private_key=private_key)

    if not notary.is_connected:
        db.close()
        _anchor_lock.release()
        return jsonify({"error": f"Cannot connect to RPC at {rpc_url}"}), 500

    try:
        agent = AccountingAgent(db=db, notary=notary)
        result = agent.anchor_pending_envelopes()
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()
        _anchor_lock.release()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
