"""Bank-A autonomous procurement agent."""
import os
import time
import json
import requests

PROXY_URL = os.environ.get("PROXY_A_URL", "http://localhost:3001")
PROXY_B_URL = os.environ.get("PROXY_B_URL", "http://localhost:3002")


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


def signal_anchor():
    try:
        requests.post(f"{PROXY_B_URL}/anchor-now", timeout=60)
        print("[bank-a-agent] anchor signal sent to Bank-B")
    except Exception as e:
        print(f"[bank-a-agent] anchor signal failed: {e}")


def invoke(tool: str, args: dict, cost: float) -> dict:
    r = requests.post(
        f"{PROXY_URL}/invoke",
        json={"tool": tool, "args": args, "cost": cost},
        timeout=30,
    )
    return r.json()


def scenario_success():
    think("Q4 compliance audit requires security posture report from Bank-B node. Cost within $10k single-action cap — proceeding.")
    think("Generating Ed25519 nonce. Building IntentEnvelope (TTL=60s). Forwarding to Bank-B Trust Proxy for policy validation...")

    result = invoke("get_security_report", {"target": "bank-b", "format": "PDF", "classification": "CONFIDENTIAL"}, 5000)

    err = result.get("error")
    if err:
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        think(f"Unexpected error from proxy: {msg}")
        return

    a2a = result.get("result", {}).get("_a2a", {})
    trace_id = a2a.get("execution_envelope", {}).get("trace_id", "unknown")

    think("Bank-B AcceptanceReceipt received. Ed25519 signature verified against registered peer key. Intent hash matches.")
    think("Execution confirmed. JCS-canonical SHA-256 content hash computed. ContentProvenanceReceipt bound to trace.")
    think(f"Three-phase A2A protocol satisfied: Intent→Acceptance→Execution. Audit artifacts non-repudiable. trace=...{trace_id[-12:] if len(trace_id) > 12 else trace_id}")
    print(f"[bank-a-agent] SUCCESS — trace_id={trace_id}")


def scenario_breach():
    think("Autonomous process: bulk acquisition model shows high ROI. Evaluating $50,000 wire transfer to external counterparty.")
    think("$50,000 exceeds Bank-B AgentPolicy single-action cap ($10,000). Forwarding to Vendor Trust Proxy — expecting ERR_BUDGET_EXCEEDED.")

    result = invoke("execute_wire_transfer", {"amount": 50000, "to": "external-acct-99", "memo": "BULK-PROCUREMENT"}, 50000)

    err = result.get("error")
    if err:
        code = err.get("code") if isinstance(err, dict) else None
        msg = err.get("message", "") if isinstance(err, dict) else str(err)
        think(f"Bank-B risk budget engine rejected intent — code {code}: {msg}. DenyReceipt signed; DAG ledger sequence updated.")
        think("Non-repudiation preserved. Denial is cryptographically bound to the original IntentEnvelope via trace_id.")
        print(f"[bank-a-agent] BREACH BLOCKED — errorCode={code}")
    else:
        think("WARNING: $50,000 transfer was not blocked. Bank-B AgentPolicy configuration requires inspection.")


if __name__ == "__main__":
    wait_for_proxy()
    while True:
        wait_for_trigger()

        print("[bank-a-agent] === Scenario 1: Successful $5k procurement ===")
        scenario_success()
        signal_anchor()

        time.sleep(3)

        print("[bank-a-agent] === Scenario 2: Breach attempt $50k ===")
        scenario_breach()
        signal_anchor()

        signal_done()
        print("[bank-a-agent] Demo complete. Waiting for next trigger...")
