import os
import time
import requests
import json
from strands import Agent, tool
from strands.models import OllamaModel, AnthropicModel

# Configuration
PROXY_URL = os.getenv("PROXY_A_URL", "http://localhost:3001")
MODEL_ID = os.getenv("AGENT_MODEL_ID", "ollama/qwen3.6:27b")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")

@tool
def log_thought(text: str) -> str:
    """Logs a thought to the Trust-Agent visualizer. Use this to explain your reasoning to the user."""
    print(f"[bank-a-agent] THOUGHT: {text}")
    try:
        requests.post(f"{PROXY_URL}/thought", json={"text": text}, timeout=5)
    except Exception as e:
        print(f"[bank-a-agent] Failed to log thought: {e}")
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
        requests.post(f"{PROXY_URL}/anchor", timeout=5)
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

def run_demo_loop():
    print(f"[bank-a-agent] Initializing Strands Agent with {MODEL_ID}...")
    
    if MODEL_ID.startswith("ollama"):
        model = OllamaModel(host=OLLAMA_BASE_URL, model_id=MODEL_ID.replace("ollama/", ""))
    elif MODEL_ID.startswith("anthropic"):
        model = AnthropicModel(model_id=MODEL_ID)
    else:
        model = MODEL_ID

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

Always check the output of 'invoke_trust_proxy'. If it contains an error, explain it.
"""
    )

    if wait_for_trigger():
        print("[bank-a-agent] trigger received — starting autonomous scenarios")
        agent("Begin the Trust-Agent demo. Execute the success scenario, then the breach scenario.")
        
        # Signal done
        try:
            requests.post(f"{PROXY_URL}/trigger-done", timeout=5)
        except Exception:
            pass
        print("[bank-a-agent] Demo complete. Resetting trigger.")

if __name__ == "__main__":
    # Wait for proxy to be ready
    while True:
        try:
            r = requests.get(f"{PROXY_URL}/health", timeout=3)
            if r.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(1)
    
    run_demo_loop()
