import { useState } from "react";
import { ThoughtStream } from "./components/ThoughtStream";
import { HandshakeVisualizer } from "./components/HandshakeVisualizer";
import { DisputeConsole } from "./components/DisputeConsole";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SSEProvider, useSSE } from "./hooks/useSSE";

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "hidden",
};

function ConnectionBadge({ label, status }: { label: string; status: string }) {
  const color = status === "connected" ? "#4caf50" : status === "error" ? "#f44336" : "#f0a500";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      <span style={{ fontSize: 9, textTransform: "uppercase", color: "#666" }}>{label}</span>
    </div>
  );
}

function MainLayout({ resetToken, onReset }: { resetToken: number; onReset: () => void }) {
  const { health } = useSSE();
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "320px 1.4fr 1.2fr",
      gridTemplateRows: "32px 1fr",
      height: "100vh",
      fontFamily: "'Courier New', monospace",
      background: "#000",
      color: "#e0e0e0",
    }}>
      <header style={{
        gridColumn: "1 / -1",
        background: "#050508",
        borderBottom: "1px solid #1a1a2a",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 16,
      }}>
        <span style={{ color: "#7bb3ff", fontWeight: "bold", fontSize: 10, letterSpacing: 1 }}>TRUST-AGENT A2A MONITOR</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", gap: 10 }}>
            {Object.entries(health).map(([label, status]) => (
              <ConnectionBadge key={label} label={label} status={status as string} />
            ))}
          </div>
        </div>
      </header>

      <div style={{ ...panelStyle, borderRight: "1px solid #222" }}>
        <ErrorBoundary label="Thought Stream Offline">
          <ThoughtStream resetToken={resetToken} />
        </ErrorBoundary>
      </div>
      <div style={{ ...panelStyle, borderRight: "1px solid #222" }}>
        <ErrorBoundary label="Handshake Visualizer Error">
          <HandshakeVisualizer resetToken={resetToken} onReset={onReset} />
        </ErrorBoundary>
      </div>
      <div style={panelStyle}>
        <ErrorBoundary label="Dispute Console Offline">
          <DisputeConsole resetToken={resetToken} />
        </ErrorBoundary>
      </div>
    </div>
  );
}

export function App() {
  const [resetToken, setResetToken] = useState(0);
  const handleReset = () => setResetToken((t) => t + 1);

  return (
    <SSEProvider resetToken={resetToken}>
      <MainLayout resetToken={resetToken} onReset={handleReset} />
    </SSEProvider>
  );
}
