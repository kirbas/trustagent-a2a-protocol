import { useState } from "react";

interface Props {
  contentHash?: string;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function ProvenanceVerifier({ contentHash }: Props) {
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [computing, setComputing] = useState(false);

  const processFile = async (file: File) => {
    setComputing(true);
    try {
      const buf = await file.arrayBuffer();
      setFileHash(await sha256Hex(buf));
      setFileName(file.name);
    } finally {
      setComputing(false);
    }
  };

  const openPicker = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) processFile(file);
    };
    input.click();
  };

  const match = contentHash && fileHash ? fileHash === contentHash : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ color: "#555", fontSize: 9, letterSpacing: 1, textTransform: "uppercase" }}>
        Verify Artifact
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) processFile(file);
        }}
        onClick={openPicker}
        style={{
          border: `1px dashed ${dragging ? "#7bb3ff" : "#2a2a3a"}`,
          borderRadius: 4, padding: "10px 8px", textAlign: "center",
          color: dragging ? "#7bb3ff" : "#3a3a4a", fontSize: 9,
          cursor: "pointer", background: dragging ? "#0d1a2a" : "#050508",
          transition: "all 0.15s", userSelect: "none",
        }}
      >
        {computing ? "Computing SHA-256…" : fileHash
          ? `↻ Re-hash (current: ${fileName})`
          : "Drop artifact file or click to select"}
      </div>

      {fileHash && (
        <div style={{ fontSize: 9, fontFamily: "monospace" }}>
          <div style={{ color: "#444", marginBottom: 2 }}>Computed SHA-256 (raw bytes):</div>
          <div style={{ color: "#a78bfa", wordBreak: "break-all", lineHeight: 1.5 }}>{fileHash}</div>
        </div>
      )}

      {contentHash && (
        <div style={{ fontSize: 9, fontFamily: "monospace" }}>
          <div style={{ color: "#444", marginBottom: 2 }}>Ledger content_hash (JCS):</div>
          <div style={{ color: "#f0a500", wordBreak: "break-all", lineHeight: 1.5 }}>{contentHash}</div>
          {!fileHash && (
            <div style={{ color: "#2a2a3a", fontSize: 8, marginTop: 4 }}>
              Note: content_hash is SHA-256 over JCS-canonical JSON. Drop the exact JSON artifact to compare.
            </div>
          )}
        </div>
      )}

      {match !== null && (
        <div style={{
          padding: "6px 8px", borderRadius: 3, fontSize: 10, fontWeight: "bold",
          background: match ? "#001a00" : "#1a0000",
          border: `1px solid ${match ? "#1a4a1a" : "#4a1a1a"}`,
          color: match ? "#4caf50" : "#f44336",
        }}>
          {match
            ? "✓ VERIFIED — Hash matches ledger record"
            : "✗ MISMATCH — File does not match ledger content_hash"}
        </div>
      )}
    </div>
  );
}
