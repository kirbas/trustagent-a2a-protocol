import os
import time
import requests
import json
import threading
from flask import Flask, jsonify
from flask_cors import CORS
from strands import Agent, tool
from strands.models import OllamaModel, AnthropicModel

# Configuration
PROXY_URL = os.getenv("PROXY_A_URL", "http://localhost:3001")
PROXY_B_URL = os.getenv("PROXY_B_URL", "http://bank-b-proxy:3002")
MODEL_ID = os.getenv("AGENT_MODEL_ID", "ollama/qwen3:8b")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")

# Flask for Health
app = Flask(__name__)
CORS(app)

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "healthy"})

def start_health_server():
    port = int(os.getenv("AGENT_PORT", 4001))
    app.run(host="0.0.0.0", port=port)

def _post_thought(text: str) -> None:
    print(f"[bank-a-agent] THOUGHT: {text}")
    try:
        requests.post(f"{PROXY_URL}/thought", json={"source": "bank-a", "text": text}, timeout=5)
    except Exception as e:
        print(f"[bank-a-agent] Failed to log thought: {e}")

@tool
def log_thought(text: str) -> str:
    """Logs a thought to the Trust-Agent visualizer. Use this to explain your reasoning to the user."""
    _post_thought(text)
    return "Thought logged."

@tool
def invoke_trust_proxy(tool_name: str, cost: float = 0, **args) -> str:
    """Calls the Bank-A Trust-Agent Proxy to interact with remote banks via A2A protocol.
    You must provide the tool_name and the expected cost in USD.
    """
    print(f"[bank-a-agent] Calling Proxy A for tool {tool_name} with cost ${cost}...")
    try:
        resp = requests.post(
            f"{PROXY_URL}/invoke",
            json={"tool": tool_name, "args": args, "cost": cost},
            timeout=120
        )
        print(f"[bank-a-agent] Proxy A response status: {resp.status_code}")
        return resp.text
    except Exception as e:
        return f"Error calling proxy: {str(e)}"

@tool
def signal_anchor_request() -> str:
    """Signals that the current transaction should be anchored to the Merkle ledger."""
    print(f"[bank-a-agent] Signaling anchor request...")
    try:
        requests.post(f"{PROXY_B_URL}/anchor-now", timeout=60)
        return "Anchor requested."
    except Exception as e:
        return f"Error signaling anchor: {str(e)}"

def wait_for_trigger():
    print("[bank-a-agent] waiting for Start Demo button...")
    while True:
        try:
            resp = requests.get(f"{PROXY_URL}/trigger-status", timeout=2)
            if resp.json().get("triggered"):
                return True
        except Exception:
            pass
        time.sleep(2)

def build_model():
    if MODEL_ID.startswith("ollama"):
        return OllamaModel(host=OLLAMA_BASE_URL, model_id=MODEL_ID.replace("ollama/", ""))
    elif MODEL_ID.startswith("anthropic"):
        return AnthropicModel(model_id=MODEL_ID.replace("anthropic/", ""))
    return MODEL_ID

def run_demo_loop():
    print(f"[bank-a-agent] Agent ready. Model: {MODEL_ID}")

    while True:
        wait_for_trigger()
        print("[bank-a-agent] trigger received — starting autonomous scenarios")
        _post_thought("Bank-A agent activated. Building IntentEnvelopes for the Trust-Agent A2A demo.")

        try:
            model = build_model()
            agent = Agent(
                model=model,
                tools=[invoke_trust_proxy, log_thought, signal_anchor_request],
                system_prompt="""You are the Bank-A Autonomous Procurement Agent.
Your goal is to demonstrate the Trust-Agent A2A (Agent-to-Agent) protocol.

MANDATORY: For every significant step of your reasoning, you MUST use the 'log_thought' tool to explain what you are doing.

ALLOWED TOOLS for 'invoke_trust_proxy':
- 'security_posture_report' (Success scenario)
- 'execute_wire_transfer' (Breach scenario)

DO NOT use capitalized names like 'SecurityPostureReport'. Use ONLY the exact strings listed above.

Demo Scenarios:
1. Scenario 1 (Success): Request 'security_posture_report' from Bank-B. Cost $5,000.
2. Scenario 2 (Breach Attempt): Attempt 'execute_wire_transfer' of $50,000.

After both scenarios, use 'signal_anchor_request' to anchor the transactions to the Merkle ledger.
Always check the output of 'invoke_trust_proxy'. If it contains an error, explain it using log_thought.
"""
            )
            agent("Begin the Trust-Agent demo. Execute the success scenario, then the breach scenario, then signal the anchor request.")
        except Exception as e:
            print(f"[bank-a-agent] Agent error: {e}")
            _post_thought(f"Agent encountered an error: {e}")

        try:
            requests.post(f"{PROXY_URL}/trigger-done", timeout=5)
        except Exception:
            pass
        print("[bank-a-agent] Demo complete. Waiting for next trigger.")
        _post_thought("Demo cycle complete. System ready for next run.")

if __name__ == "__main__":
    threading.Thread(target=start_health_server, daemon=True).start()

    while True:
        try:
            r = requests.get(f"{PROXY_URL}/health", timeout=3)
            if r.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(1)

    run_demo_loop()
