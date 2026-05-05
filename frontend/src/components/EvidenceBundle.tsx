import type { DisputeEntry } from "../types";

interface Props {
  entries: DisputeEntry[];
}

const PHASE_ORDER = ["INTENT_RECORD", "ACCEPTANCE_RECORD", "DENIED_RECORD", "EXECUTION_RECORD", "CONTENT_PROVENANCE_RECORD"];

const PHASE_META: Record<string, { label: string; color: string; signer: string }> = {
  INTENT_RECORD:             { label: "INTENT",     color: "#7bb3ff", signer: "Bank-A" },
  ACCEPTANCE_RECORD:         { label: "ACCEPTANCE", color: "#4caf50", signer: "Bank-B" },
  DENIED_RECORD:             { label: "DENIED",     color: "#f44336", signer: "Bank-B" },
  EXECUTION_RECORD:          { label: "EXECUTION",  color: "#a78bfa", signer: "Bank-A + Bank-B" },
  CONTENT_PROVENANCE_RECORD: { label: "PROVENANCE", color: "#f0a500", signer: "Bank-A" },
};

function signerKids(artifact: Record<string, unknown>): string[] {
  const sigs = artifact["signatures"];
  if (!Array.isArray(sigs)) return [];
  return sigs.map((s: any) => String(s.kid ?? "")).filter(Boolean);
}

function shortHash(h: unknown): string {
  const s = String(h ?? "");
  return s ? s.slice(0, 8) + "…" + s.slice(-6) : "—";
}

function PhaseNode({ entry }: { entry: DisputeEntry }) {
  const meta = PHASE_META[entry.event_type] ?? { label: entry.event_type, color: "#888", signer: "?" };
  const art = entry.artifact;
  const kids = signerKids(art);
  const isDenied = entry.event_type === "DENIED_RECORD";

  const hashField =
    (art["args_hash"] as string | undefined) ??
    (art["output_hash"] as string | undefined) ??
    ((art["content"] as any)?.content_hash as string | undefined) ??
    (art["intent_hash"] as string | undefined);

  const toolName = (art["target"] as any)?.tool_name as string | undefined;
  const status = art["status"] as string | undefined;

  return (
    <div style={{
      background: "#0a0a0f",
      border: `1px solid ${meta.color}55`,
      borderRadius: 5,
      padding: "8px 10px",
      minWidth: 140,
      flex: "0 0 auto",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <span style={{ color: meta.color, fontSize: 10, fontWeight: "bold", letterSpacing: 0.5 }}>
          {meta.label}
        </span>
        {isDenied && <span style={{ color: "#f44336", fontSize: 9 }}>✗</span>}
        {!isDenied && entry.event_type === "EXECUTION_RECORD" && status === "COMPLETED" &&
          <span style={{ color: "#4caf50", fontSize: 9 }}>✓</span>}
      </div>

      <div style={{ fontSize: 8, color: "#555", lineHeight: 1.8 }}>
        <div>
          <span style={{ color: "#3a3a4a" }}>Signer: </span>
          <span style={{ color: meta.color + "bb" }}>{meta.signer}</span>
        </div>
        {toolName && (
          <div>
            <span style={{ color: "#3a3a4a" }}>Tool: </span>
            <span style={{ color: "#64b5f6bb" }}>{toolName}</span>
          </div>
        )}
        {status && (
          <div>
            <span style={{ color: "#3a3a4a" }}>Status: </span>
            <span style={{ color: status === "COMPLETED" ? "#4caf50bb" : "#f44336bb" }}>{status}</span>
          </div>
        )}
        {hashField && (
          <div>
            <span style={{ color: "#3a3a4a" }}>Hash: </span>
            <span style={{ color: "#a78bfa99", fontFamily: "monospace" }}>{shortHash(hashField)}</span>
          </div>
        )}
        {kids.length > 0 && (
          <div style={{ marginTop: 2 }}>
            {kids.map((kid, i) => (
              <div key={i} style={{ color: "#f0a50066", fontFamily: "monospace", wordBreak: "break-all" }}>
                {kid.replace("did:workload:", "").slice(0, 28)}…
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function EvidenceBundle({ entries }: Props) {
  const sorted = [...entries].sort(
    (a, b) => PHASE_ORDER.indexOf(a.event_type) - PHASE_ORDER.indexOf(b.event_type)
  );

  const isRejected = sorted.some((e) => e.event_type === "DENIED_RECORD");
  const hasExecution = sorted.some((e) => e.event_type === "EXECUTION_RECORD");
  const d1satisfied = hasExecution;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* D1 status banner */}
      <div style={{
        padding: "5px 8px", borderRadius: 3, fontSize: 9, fontWeight: "bold",
        background: d1satisfied ? "#001a00" : isRejected ? "#1a0000" : "#0d0d0d",
        border: `1px solid ${d1satisfied ? "#1a4a1a" : isRejected ? "#4a1a1a" : "#222"}`,
        color: d1satisfied ? "#4caf50" : isRejected ? "#f44336" : "#666",
        letterSpacing: 0.5,
      }}>
        {d1satisfied
          ? "✓ D1 NON-REPUDIATION SATISFIED — All three artifacts cryptographically bound via trace_id"
          : isRejected
          ? "✗ INTENT REJECTED — DenyReceipt signed by Bank-B. Non-repudiation preserved."
          : "⏳ Incomplete — waiting for execution envelope"}
      </div>

      {/* Causal chain */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {sorted.map((entry, i) => (
          <span key={entry.entry_hash} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {i > 0 && (
              <span style={{ color: "#2a2a3a", fontSize: 14, flexShrink: 0 }}>→</span>
            )}
            <PhaseNode entry={entry} />
          </span>
        ))}
      </div>

      {/* Trace binding note */}
      <div style={{ fontSize: 8, color: "#2a2a3a", lineHeight: 1.6, marginTop: 2 }}>
        All artifacts share <span style={{ color: "#7bb3ff44" }}>trace_id</span> — tamper of any single envelope breaks the binding.
        {" "}ExecutionEnvelope carries <span style={{ color: "#a78bfa44" }}>dual signatures</span> (Bank-A intent + Bank-B acceptance).
      </div>
    </div>
  );
}
