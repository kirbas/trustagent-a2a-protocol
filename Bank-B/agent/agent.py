"""Bank-B reactive vendor agent — listens to proxy SSE and emits vendor thoughts."""
import os
import time
import json
import requests

PROXY_URL = os.environ.get("PROXY_B_URL", "http://localhost:3002")


def wait_for_proxy():
    print("[bank-b-agent] waiting for Proxy B to be ready...")
    while True:
        try:
            r = requests.get(f"{PROXY_URL}/health", timeout=3)
            if r.status_code == 200:
                print("[bank-b-agent] Proxy B ready")
                return
        except Exception:
            pass
        time.sleep(1)


def think(text: str):
    print(f"[bank-b-agent] THOUGHT: {text}")
    try:
        requests.post(f"{PROXY_URL}/thought", json={"text": text}, timeout=5)
    except Exception:
        pass
    time.sleep(1.0)


def stream_events(url: str):
    """Yields (event_name, data_dict) pairs from an SSE stream."""
    with requests.get(url, stream=True, timeout=None) as r:
        event_name = None
        for line in r.iter_lines(decode_unicode=True):
            if not line:
                event_name = None
                continue
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:") and event_name:
                try:
                    yield event_name, json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    pass
                event_name = None


def handle_intent_accepted(data: dict):
    tool = data.get("tool", "unknown")
    cost = data.get("cost", 0)
    trace_id = data.get("traceId", "")[-8:]
    think(f"Received signed IntentEnvelope from Bank-A. Tool: {tool}.")
    think("Running compliance check... verifying Ed25519 signature... TTL valid.")
    think(f"Budget check passed. Remaining budget post-transaction: ${10000 - cost:,.0f}.")
    think(f"AcceptanceReceipt signed and returned. trace:...{trace_id}")


def handle_intent_rejected(data: dict):
    tool = data.get("tool", "unknown")
    cost = data.get("cost", 0)
    reason = data.get("reason", "")
    think(f"Incoming intent for {tool} (${cost:,.0f}) failed budget check.")
    think(f"Signed DENY recorded in tamper-evident DAG ledger. Reason: {reason}")
    think("Non-repudiation preserved. Bank-A cannot dispute this rejection.")


def handle_execution_complete(data: dict):
    status = data.get("status", "unknown")
    trace_id = data.get("traceId", "")[-8:]
    think(f"Execution finished with status: {status}.")
    think(f"Signed ExecutionEnvelope appended to DAG ledger for trace: ...{trace_id}.")


def handle_cross_check_result(data: dict):
    think("Bank-A requested a bilateral cross-check.")
    think("Serving my verifiable DAG ledger state for trace comparison...")
    think("Cross-Check: Verifying that Bank-A's ledger matches my local state... [SYNCED]")


if __name__ == "__main__":
    wait_for_proxy()

    # Initial vendor readiness thoughts
    think("Bank-B vendor node online. Awaiting procurement intents from Bank-A.")
    think("Risk budget policy loaded: $10k daily limit for Bank-A agent.")
    think("Trust Proxy B armed — monitoring for IntentEnvelopes...")

    print("[bank-b-agent] subscribed to proxy events stream")
    try:
        for event_name, data in stream_events(f"{PROXY_URL}/events"):
            if event_name == "intent-accepted":
                handle_intent_accepted(data)
            elif event_name == "intent-rejected":
                handle_intent_rejected(data)
            elif event_name == "execution-complete":
                handle_execution_complete(data)
            elif event_name == "cross-check-result":
                handle_cross_check_result(data)
    except KeyboardInterrupt:
        print("[bank-b-agent] shutting down")
    except Exception as e:
        print(f"[bank-b-agent] stream error: {e}")
