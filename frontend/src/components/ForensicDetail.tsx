import { useState } from "react";
import type { DisputeEntry, DisputePack, InclusionProof } from "../types";
import { ProvenanceVerifier } from "./ProvenanceVerifier";

// ── JSON syntax highlighter ──────────────────────────────────────────────────

function keyColor(key: string): string {
  if (/^(sig|signatures|kid|alg)$/.test(key)) return "#f0a500";
  if (/hash/.test(key)) return "#a78bfa";
  if (key === "trace_id" || key === "nonce") return "#7bb3ff";
  if (/^(envelope_type|spec_version|status)$/.test(key)) return "#4caf50";
  if (/^(tool_name|method)$/.test(key)) return "#64b5f6";
  if (/^(created_at|expires_at|ts)$/.test(key)) return "#444";
  return "#888";
}

function valueColor(key: string, raw: string): string {
  if (/^(sig|kid|alg)$/.test(key)) return "#f0a50099";
  if (/hash/.test(key)) return "#a78bfa99";
  if (key === "trace_id" || key === "nonce") return "#7bb3ff99";
  if (raw.includes('"did:')) return "#64b5f699";
  if (/^"(INTENT|ACCEPTANCE|EXECUTION|DENIED|COMPLETED|FAILED)"/.test(raw.trim())) return "#4caf5099";
  if (/^"/.test(raw.trim())) return "#c0c0c0";
  if (/^(true|false|null)/.test(raw.trim())) return "#ff980099";
  if (/^\d/.test(raw.trim())) return "#4caf5099";
  return "#777";
}

function JsonLine({ line }: { line: string }) {
  const m = line.match(/^(\s*)"([^"]+)":\s*(.+)$/);
  if (m) {
    const [, indent, key, rest] = m;
    return (
      <div style={{ whiteSpace: "pre" }}>
        <span style={{ color: "#2a2a3a" }}>{indent}</span>
        <span style={{ color: keyColor(key) }}>"{key}"</span>
        <span style={{ color: "#2a2a3a" }}>: </span>
        <span style={{ color: valueColor(key, rest) }}>{rest}</span>
      </div>
    );
  }
  const trimmed = line.trim();
  const bracketColor = /^[{}\[\],]/.test(trimmed) ? "#2a2a3a" : "#555";
  return <div style={{ whiteSpace: "pre", color: bracketColor }}>{line}</div>;
}

function JsonHighlighter({ value }: { value: unknown }) {
  const lines = JSON.stringify(value, null, 2).split("\n");
  return (
    <div style={{ fontFamily: "monospace", fontSize: 9, lineHeight: 1.65, overflowX: "auto" }}>
      {lines.map((line, i) => <JsonLine key={i} line={line} />)}
    </div>
  );
}

// ── Phase badge ──────────────────────────────────────────────────────────────

const PHASE_COLOR: Record<string, string> = {
  INTENT_RECORD: "#7bb3ff",
  ACCEPTANCE_RECORD: "#4caf50",
  DENIED_RECORD: "#f44336",
  EXECUTION_RECORD: "#a78bfa",
  CONTENT_PROVENANCE_RECORD: "#f0a500",
};

function phaseLabel(eventType: string): string {
  return eventType.replace("_RECORD", "").replace("_", " ");
}

// ── Inclusion proof summary ──────────────────────────────────────────────────

function ProofRow({ proof }: { proof: InclusionProof }) {
  const [open, setOpen] = useState(false);
  const batch = proof.batch;
  return (
    <div style={{ borderRadius: 3, border: "1px solid #1a1a2a", overflow: "hidden", marginBottom: 4 }}>
      <div
        onClick={() => setOpen((p) => !p)}
        style={{
          padding: "4px 8px", cursor: "pointer", background: "#080810",
          display: "flex", gap: 8, alignItems: "center", fontSize: 9,
        }}
      >
        <span style={{ color: "#f0a500", letterSpacing: 0.5 }}>⛓ MERKLE PROOF</span>
        <span style={{ color: "#444", fontFamily: "monospace" }}>
          root: {(batch.merkle_root ?? "").slice(0, 12)}…
        </span>
        <span style={{ marginLeft: "auto", color: "#333" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ padding: "6px 8px", background: "#050508" }}>
          <div style={{ fontSize: 8, color: "#444", lineHeight: 2, fontFamily: "monospace" }}>
            <div><span style={{ color: "#333" }}>merkle_root: </span>
              <span style={{ color: "#f0a50099" }}>{batch.merkle_root}</span>
            </div>
            <div><span style={{ color: "#333" }}>proof_steps: </span>
              <span style={{ color: "#777" }}>{proof.proof.length}</span>
            </div>
            <div><span style={{ color: "#333" }}>entry_hash: </span>
              <span style={{ color: "#a78bfa99" }}>{proof.entry_hash}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Entry card ───────────────────────────────────────────────────────────────

function EntryCard({ entry, proof }: { entry: DisputeEntry; proof: InclusionProof | undefined }) {
  const [open, setOpen] = useState(false);
  const color = PHASE_COLOR[entry.event_type] ?? "#888";
  const contentHash = (entry.artifact["content"] as any)?.content_hash as string | undefined;
  const isProvenance = entry.event_type === "CONTENT_PROVENANCE_RECORD";

  return (
    <div style={{
      border: `1px solid ${color}33`, borderRadius: 5, overflow: "hidden", marginBottom: 6,
    }}>
      <div
        onClick={() => setOpen((p) => !p)}
        style={{
          padding: "6px 10px", cursor: "pointer", background: "#08080f",
          display: "flex", alignItems: "center", gap: 8, userSelect: "none",
        }}
      >
        <span style={{
          color, fontSize: 9, fontWeight: "bold", letterSpacing: 0.5,
          background: color + "1a", padding: "1px 5px", borderRadius: 2,
        }}>
          {phaseLabel(entry.event_type)}
        </span>
        {proof && <span style={{ color: "#f0a50055", fontSize: 8 }}>⛓ anchored</span>}
        <span style={{ marginLeft: "auto", color: "#333", fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ padding: "8px 10px", background: "#050508", borderTop: `1px solid ${color}22` }}>
          <JsonHighlighter value={entry.artifact} />

          {proof && (
            <div style={{ marginTop: 8 }}>
              <ProofRow proof={proof} />
            </div>
          )}

          {isProvenance && (
            <div style={{ marginTop: 10, borderTop: "1px solid #1a1a2a", paddingTop: 8 }}>
              <ProvenanceVerifier contentHash={contentHash} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ForensicDetail({ pack }: { pack: DisputePack }) {
  const proofByHash = new Map(pack.inclusionProofs.map((p) => [p.entry_hash, p]));

  const ordered = [...pack.entries].sort((a, b) => {
    const ORDER = ["INTENT_RECORD", "ACCEPTANCE_RECORD", "DENIED_RECORD", "EXECUTION_RECORD", "CONTENT_PROVENANCE_RECORD"];
    return ORDER.indexOf(a.event_type) - ORDER.indexOf(b.event_type);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {/* Phase summary strip */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
        {ordered.map((e) => {
          const color = PHASE_COLOR[e.event_type] ?? "#888";
          return (
            <span key={e.entry_hash} style={{
              padding: "2px 6px", borderRadius: 2, fontSize: 8,
              background: color + "1a", color: color, border: `1px solid ${color}44`,
            }}>
              {phaseLabel(e.event_type)}
            </span>
          );
        })}
        {pack.inclusionProofs.length > 0 && (
          <span style={{
            padding: "2px 6px", borderRadius: 2, fontSize: 8,
            background: "#f0a5001a", color: "#f0a50099", border: "1px solid #f0a50044",
          }}>
            ⛓ {pack.inclusionProofs.length} anchor proof(s)
          </span>
        )}
      </div>

      {ordered.length === 0 && (
        <div style={{ color: "#333", fontSize: 10 }}>No entries in this dispute pack.</div>
      )}

      {ordered.map((entry) => (
        <EntryCard
          key={entry.entry_hash}
          entry={entry}
          proof={proofByHash.get(entry.entry_hash)}
        />
      ))}
    </div>
  );
}
