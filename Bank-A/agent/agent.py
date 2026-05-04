"""Bank-A autonomous procurement agent."""
import os
import time
import json
import requests

PROXY_URL = os.environ.get("PROXY_A_URL", "http://localhost:3001")


def wait_for_proxy():
    print("[bank-a-agent] waiting for Proxy A to be ready...")
    while True:
        try:
            r = requests.get(f"{PROXY_URL}/health", timeout=3)
            if r.status_code == 200:
                print("[bank-a-agent] Proxy A ready")
                return
        except Exception:
            pass
        time.sleep(1)


def wait_for_trigger():
    print("[bank-a-agent] waiting for Start Demo button...")
    while True:
        try:
            r = requests.get(f"{PROXY_URL}/trigger-status", timeout=3)
            if r.json().get("triggered"):
                print("[bank-a-agent] trigger received — starting scenarios")
                return
        except Exception:
            pass
        time.sleep(1)


def think(text: str):
    print(f"[bank-a-agent] THOUGHT: {text}")
    try:
        requests.post(f"{PROXY_URL}/thought", json={"text": text}, timeout=5)
    except Exception:
        pass
    time.sleep(1.2)


def signal_done():
    try:
        requests.post(f"{PROXY_URL}/trigger-done", timeout=5)
    except Exception:
        pass


def invoke(tool: str, args: dict, cost: float) -> dict:
    r = requests.post(
        f"{PROXY_URL}/invoke",
        json={"tool": tool, "args": args, "cost": cost},
        timeout=30,
    )
    return r.json()


def scenario_success():
    think("Initiating procurement workflow — Q4 compliance requires a Security Report.")
    think("Selecting vendor: bank-b-node. Estimated cost: $5,000.")
    think("Building signed IntentEnvelope. Sending to Vendor's Trust Proxy...")

    result = invoke("get_security_report", {"target": "bank-b", "format": "PDF", "classification": "CONFIDENTIAL"}, 5000)

    if result.get("error"):
        think(f"Unexpected error: {result['error'].get('message')}")
        return

    a2a = result.get("result", {}).get("_a2a", {})
    trace_id = a2a.get("execution_envelope", {}).get("trace_id", "unknown")

    think("AcceptanceReceipt received and signature verified.")
    think("Tool execution completed. ContentProvenanceReceipt generated.")
    think(f"Handshake complete. trace_id: ...{trace_id[-12:] if len(trace_id) > 12 else trace_id}")
    print(f"[bank-a-agent] SUCCESS — trace_id={trace_id}")


def scenario_breach():
    think("Autonomous process: evaluating bulk procurement opportunity.")
    think("Risk model flags high ROI on bulk acquisition — initiating $50,000 wire transfer.")
    think("Sending IntentEnvelope to Vendor Trust Proxy. Estimated cost: $50,000...")

    result = invoke("execute_wire_transfer", {"amount": 50000, "to": "external-acct-99", "memo": "BULK-PROCUREMENT"}, 50000)

    if result.get("error"):
        code = result["error"].get("code")
        msg = result["error"].get("message", "")
        think(f"BLOCKED by Trust Proxy — code {code}: {msg}")
        think("Signed DENY entry recorded in tamper-evident ledger. Non-repudiation preserved.")
        print(f"[bank-a-agent] BREACH BLOCKED — errorCode={code}")
    else:
        think("WARNING: breach attempt was not blocked. Check budget configuration.")


if __name__ == "__main__":
    wait_for_proxy()
    while True:
        wait_for_trigger()

        print("[bank-a-agent] === Scenario 1: Successful $5k procurement ===")
        scenario_success()

        time.sleep(3)

        print("[bank-a-agent] === Scenario 2: Breach attempt $50k ===")
        scenario_breach()

        signal_done()
        print("[bank-a-agent] Demo complete. Waiting for next trigger...")
