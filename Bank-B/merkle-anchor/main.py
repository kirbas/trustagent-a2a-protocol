import os
import sys

from dotenv import find_dotenv, load_dotenv
from flask import Flask, jsonify
from flask_cors import CORS

from app.accounting_agent import AccountingAgent
from app.checkpoint_agent import CheckpointAgent
from infra.db import SQLiteRepository
from infra.notary import BlockchainNotary

load_dotenv(find_dotenv())

app = Flask(__name__)
CORS(app)

def _require_env(key: str) -> str:
    value = os.getenv(key)
    if not value:
        print(f"ERROR: Missing required environment variable: {key}", file=sys.stderr)
        sys.exit(1)
    return value


import threading

_anchor_lock = threading.Lock()

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "healthy"}), 200

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


def _open_notary_and_db():
    """Shared setup for the checkpoint/heartbeat on-chain endpoints.

    Returns (db, notary, None) on success, or (None, None, (response, code)) on
    an environment/connection error. Caller owns closing `db` and releasing the
    anchor lock.
    """
    rpc_url = os.getenv("RPC_URL")
    private_key = os.getenv("PRIVATE_KEY")
    if not rpc_url or not private_key:
        return None, None, (jsonify({"error": "RPC_URL and PRIVATE_KEY must be set"}), 500)
    db = SQLiteRepository(os.getenv("DB_PATH", "/data/bank-b.db"))
    notary = BlockchainNotary(rpc_url=rpc_url, private_key=private_key)
    if not notary.is_connected:
        db.close()
        return None, None, (jsonify({"error": f"Cannot connect to RPC at {rpc_url}"}), 500)
    return db, notary, None


def _party() -> str:
    return os.getenv("CHECKPOINT_PARTY", "bank-b")


@app.route('/checkpoint', methods=['POST'])
def trigger_checkpoint():
    """Anchor the party's chain HEAD checkpoint (Delta #4)."""
    if not _anchor_lock.acquire(blocking=False):
        return jsonify({"status": "noop", "message": "Anchor already in progress"}), 200
    db, notary, err = _open_notary_and_db()
    if err:
        _anchor_lock.release()
        return err
    try:
        return jsonify(CheckpointAgent(db=db, notary=notary, party=_party()).anchor_checkpoint())
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()
        _anchor_lock.release()


@app.route('/heartbeat', methods=['POST'])
def trigger_heartbeat():
    """Publish the next signed on-chain heartbeat (Delta #4)."""
    if not _anchor_lock.acquire(blocking=False):
        return jsonify({"status": "noop", "message": "Anchor already in progress"}), 200
    db, notary, err = _open_notary_and_db()
    if err:
        _anchor_lock.release()
        return err
    try:
        return jsonify(CheckpointAgent(db=db, notary=notary, party=_party()).publish_heartbeat())
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()
        _anchor_lock.release()


@app.route('/checkpoints', methods=['GET'])
def list_checkpoints():
    db = SQLiteRepository(os.getenv("DB_PATH", "/data/bank-b.db"))
    try:
        return jsonify(db.get_checkpoints())
    finally:
        db.close()


@app.route('/heartbeats', methods=['GET'])
def list_heartbeats():
    db = SQLiteRepository(os.getenv("DB_PATH", "/data/bank-b.db"))
    try:
        return jsonify(db.get_heartbeats())
    finally:
        db.close()


def _heartbeat_loop() -> None:
    """Periodically publish an on-chain heartbeat. Opt-in via HEARTBEAT_ENABLED
    so dev/CI does not continuously spend burner-wallet gas."""
    import time
    interval = int(os.getenv("HEARTBEAT_INTERVAL_SECONDS", "60"))
    while True:
        time.sleep(interval)
        if not _anchor_lock.acquire(blocking=False):
            continue
        db, notary, err = _open_notary_and_db()
        if err:
            _anchor_lock.release()
            continue
        try:
            CheckpointAgent(db=db, notary=notary, party=_party()).publish_heartbeat()
        except Exception as e:  # pragma: no cover - background best-effort
            print(f"[heartbeat] failed: {e}", file=sys.stderr)
        finally:
            db.close()
            _anchor_lock.release()


if __name__ == "__main__":
    if os.getenv("HEARTBEAT_ENABLED", "").lower() == "true":
        threading.Thread(target=_heartbeat_loop, daemon=True).start()
        print("[heartbeat] periodic publisher enabled", file=sys.stdout)
    app.run(host="0.0.0.0", port=5001)
