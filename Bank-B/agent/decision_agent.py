import os
import json
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from strands import Agent
from strands.models.ollama import OllamaModel
from strands.models.anthropic import AnthropicModel
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)
PROXY_URL = os.environ.get("PROXY_B_URL", "http://bank-b-proxy:3002")
MODEL_ID = os.environ.get("AGENT_MODEL_ID", "ollama/qwen3.6:27b")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434")

def log_thought(text: str):
    """Logs vendor reasoning to the system visualizer."""
    try:
        requests.post(f"{PROXY_URL}/thought", json={"text": text}, timeout=5)
    except Exception:
        pass
    print(f"[bank-b-agent] THOUGHT: {text}")

@app.route("/decide", methods=["POST"])
def decide():
    try:
        data = request.json
        intent = data.get("intent", {})
        cost = data.get("cost", 0)
        
        # Extract details for the prompt
        requester = intent.get("initiator", {}).get("did", "unknown")
        tool_name = intent.get("target", {}).get("tool_name", "unknown")
        
        log_thought(f"Incoming intent evaluation: {tool_name} from {requester} at cost ${cost:,.2f}")
        
        print(f"[bank-b-agent] Initializing model {MODEL_ID} at {OLLAMA_BASE_URL}")
        if MODEL_ID.startswith("ollama"):
            model = OllamaModel(host=OLLAMA_BASE_URL, model_id=MODEL_ID.replace("ollama/", ""))
        elif MODEL_ID.startswith("anthropic"):
            model = AnthropicModel(model_id=MODEL_ID.replace("anthropic/", ""))
        else:
            model = MODEL_ID

        print(f"[bank-b-agent] Creating Agent...")
        agent = Agent(
            model=model,
            system_prompt=f"""You are the Bank-B Vendor Decision Agent. 
    Your job is to evaluate incoming 'IntentEnvelopes' from other agents and decide whether to accept or reject them based on Bank-B policy.

    POLICY:
    1. Maximum single action cost: $10,000 USD.
    2. Daily cumulative budget for any single requester: $10,000 USD.
    3. Allowed tools: 'get_security_report', 'security_posture_report', 'get_security_posture_report', 'get_document', 'execute_wire_transfer'.
    4. Requester DID MUST start with 'did:workload:bank-a-agent'.

    EVALUATION CRITERIA:
    - If cost > 10000, REJECT with errorCode 'ERR_BUDGET_EXCEEDED'.
    - If tool is not in allowed list, REJECT with errorCode 'ERR_INVALID_TOOL'.
    - If requester is unauthorized, REJECT with errorCode 'ERR_UNAUTHORIZED'.

    Output your decision as a strict JSON object:
    {{
      "decision": "accept" | "reject",
      "reason": "Clear explanation of why",
      "errorCode": "Optional error code if rejected"
    }}
    """
        )
        
        # Run the agent reasoning
        print(f"[bank-b-agent] Calling agent...")
        result_text = str(agent(f"Evaluate this intent: {json.dumps(intent)} with estimated cost {cost}"))
        print(f"[bank-b-agent] Agent returned: {result_text}")
        
        # Clean up the output to extract JSON
        clean_json = result_text.strip()
        if "```json" in clean_json:
            clean_json = clean_json.split("```json")[1].split("```")[0].strip()
        elif "```" in clean_json:
            clean_json = clean_json.split("```")[1].split("```")[0].strip()
        
        decision = json.loads(clean_json)
        
        log_thought(f"Evaluation complete. Decision: {decision.get('decision').upper()} - {decision.get('reason')}")
        return jsonify(decision)
        
    except Exception as e:
        print(f"[bank-b-agent] Error during decision: {e}")
        log_thought(f"Internal error evaluating intent: {e}")
        return jsonify({
            "decision": "reject",
            "reason": f"Agent internal error: {str(e)}",
            "errorCode": "ERR_AGENT_INTERNAL_ERROR"
        }), 500

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "healthy"})

if __name__ == "__main__":
    port = int(os.environ.get("AGENT_PORT", 4002))
    print(f"[bank-b-agent] Starting Decision Agent on port {port}...")
    app.run(host="0.0.0.0", port=port)
