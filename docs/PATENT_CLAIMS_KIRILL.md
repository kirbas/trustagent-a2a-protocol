# Patent Application Materials: Core Inventions and Architectural Concept (Contributions by Kirill Ostrovsky)

## 1. Field of the Invention and Utility
The invention relates to the field of computer systems, artificial intelligence system integration protocols, and cryptographic methods for ensuring accountability. The purpose of the invention is to eliminate the legal and financial liability gap during autonomous invocation of external tools and APIs by autonomous agents via the Model Context Protocol (MCP).

---

## 2. Architectural Elements of the Concept

### 2.1. Execution Accountability Layer Concept
* **Separation of Logic and Accountability**: Architectural decoupling of artificial intelligence decision-making processes (Reasoning/Logic) from cryptographic commitment binding (Commitment/Accountability) for the outcome of an executed action.
* **"No Log, No Action" Principle**: Architectural invariant under which an executable tool is not activated until the intention is guaranteed to be preliminarily committed to a cryptographic ledger.

### 2.2. Transparent Intercepting Sidecar Pattern (Trust Proxy Sidecar)
* **Embedding into the MCP Transport Channel**: Architecture of a proxy server (Trust Proxy Sidecar) transparently intercepting Model Context Protocol standard calls (JSON-RPC `tools/call`) at the `stdio` and `SSE` transport levels.
* **Automated Dispute Error Responses**: Upon blocking an unauthorized action, the gateway returns a standard JSON-RPC error response containing a cryptographic dispute identifier (`dispute_id`).

### 2.3. A2A 3-Phase Handshake Protocol Model
* **Phase 1: Intent Registration (Intent Phase)** — generation and signing of an intent envelope by the operation initiator.
* **Phase 2: Policy Verification and Agreement (Acceptance Phase)** — authorization verification and generation of an acceptance receipt by the executor.
* **Phase 3: Execution Confirmation (Execution Phase)** — cryptographic commitment of the tool invocation result.
* **Phase 4 (Optional): Receipt Acknowledgment (Receipt Ack)** — confirmation by the initiator of proof of delivery.

### 2.4. Two-Tier Trust Model
* **Local Tier (Local Streaming DAG Ledger)**: Concept of representing the local transaction journal as a Directed Acyclic Graph (DAG) to enable non-blocking concurrent event recording and support branching subtasks.
* **Global Tier (Public L2 Blockchain Anchoring)**: Concept of periodic anchoring of the aggregated state of the local ledger to a public Layer 2 blockchain (Base / Ethereum) to establish temporal sequence without disclosing private data.

---

## 3. Specific Technical Solutions, Data Structures, and Algorithms

### 3.1. Signature-Exclusion Hash Computation Algorithm (Hash Target Rule)
* **Essence of the Solution**: Enabling the addition and updating of digital signatures without altering the identifier of the envelope itself.
* **Mathematical Model**:
  The envelope hash ($\text{envelope\_hash}$) is computed according to the formula:
  $$\text{envelope\_hash} = \text{SHA-256}\Big(\text{JCS}\big(\text{Envelope} \setminus \{\text{"signatures"}\}\big)\Big)$$
  where $\text{JCS}$ is JSON Canonicalization Scheme compliant with RFC 8785.
* **Technical Result**: Elimination of cyclic dependencies when applying counter- and co-signatures by multiple independent parties.

### 3.2. Data Structure Canonicalization compliant with RFC 8785 (JCS Canonicalization)
* **Essence of the Solution**: Ensuring cross-platform hash determinism regardless of programming language (TypeScript, Python, Rust), dictionary key ordering, and whitespace characters.

### 3.3. Core Cryptographic Envelope Structure Specifications (Envelope Schema)
* **`IntentEnvelope` Structure**:
  Binds parameters: `initiator_did` (decentralized identifier of the initiator), `tool_name`, `args_hash` (hash of arguments), `tool_schema_hash` (hash of the tool schema to prevent API spoofing/tampering attacks), `mcp_deployment_id`, and `expires_at` (strict time-to-live).
* **`AcceptanceReceipt` Structure**:
  Binds parameters: `executor_did`, `intent_hash`, `policy_eval_hash` (hash of applied OPA / VC rules), and timestamp `accepted_at`.
* **`ExecutionEnvelope` Structure**:
  Binds parameters: `executor_did`, `intent_hash`, `output_hash` (hash of the output/result), `executed_at`, and `status`.
* **`ContentProvenanceReceipt` Structure**:
  Receipt binding agent-generated content to a transaction via `artifact_hash` and `schema_version`.

### 3.4. Replay Protection Algorithm (Anti-Replay via Nonce & TTL)
* **Essence of the Solution**: Prevention of replay attacks in a distributed environment.
* **Execution Order**:
  1. Freshness condition check: $\text{current\_time} \le \text{expires\_at} + \text{skew\_tolerance}$.
  2. Uniqueness check of the single-use number $\text{nonce}$ in the `NonceRegistry` for a given `initiator_did`.
  3. Upon detecting a duplicate $\text{nonce}$ within the validity window, the transaction is immediately blocked.

### 3.5. Preliminary Risk Control Algorithm (RiskBudgetEngine)
* **Essence of the Solution**: Prevention of unauthorized agent financial expenditures during hallucinations or when exceeding established limits.
* **Execution Order**:
  1. Extraction of the operation cost from the invocation parameters.
  2. Spend limit compliance check and verification of provided Verifiable Credentials (VC).
  3. Commitment of the verification outcome as a policy hash `policy_eval_hash` within `AcceptanceReceipt`.

---

## 4. Summary Table of Core Entities for Patent Application

| Invention Object | Technical Essence | Achieved Technical Result |
|---|---|---|
| **Trust Proxy Interceptor** | JSON-RPC proxy-interceptor for the MCP standard | Elimination of uncontrolled direct access by an agent to tools |
| **3-Phase Handshake** | Separation of interaction into Intent, Acceptance, and Execution | Clear demarcation of liability between purchaser and executor |
| **Hash Target Rule** | Envelope body hashing algorithm excluding signature fields via JCS (RFC 8785) | Deterministic hash calculation and support for multi-signatures |
| **Context-Bound Schemas** | Inclusion of `tool_schema_hash` and `deployment_id` in the intent body | Protection against tool schema tampering attacks and rogue third-party deployments |
| **Nonce & TTL Registry** | Sliding cache of consumed nonces with TTL validation | Guaranteed protection against packet replay attacks |
| **Risk Budget Gate** | Pre-validation of financial limits and VC certificates prior to execution | Prevention of unauthorized financial losses |
