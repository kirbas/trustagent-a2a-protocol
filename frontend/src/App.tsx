import { useState } from "react";
import { ThoughtStream } from "./components/ThoughtStream";
import { HandshakeVisualizer } from "./components/HandshakeVisualizer";
import { DisputeConsole } from "./components/DisputeConsole";
import { ErrorBoundary } from "./components/ErrorBoundary";

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "hidden",
};

export function App() {
  const [resetToken, setResetToken] = useState(0);
  const handleReset = () => setResetToken((t) => t + 1);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1.6fr 1.6fr",
        height: "100vh",
        fontFamily: "'Courier New', monospace",
        background: "#0a0a0f",
        color: "#e0e0e0",
        fontSize: 13,
      }}
    >
      <div style={{ ...panelStyle, borderRight: "1px solid #222" }}>
        <ErrorBoundary label="Thought Stream Offline">
          <ThoughtStream resetToken={resetToken} />
        </ErrorBoundary>
      </div>
      <div style={{ ...panelStyle, borderRight: "1px solid #222" }}>
        <ErrorBoundary label="Handshake Visualizer Error">
          <HandshakeVisualizer resetToken={resetToken} onReset={handleReset} />
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
