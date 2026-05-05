import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100%", gap: 12, padding: 24,
        }}>
          <div style={{ color: "#f44336", fontSize: 28 }}>⚠</div>
          <div style={{ color: "#f44336", fontWeight: "bold", fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>
            {this.props.label ?? "Node Offline"}
          </div>
          <div style={{ color: "#555", fontSize: 10, textAlign: "center", maxWidth: 240, lineHeight: 1.6 }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              padding: "4px 14px", background: "#1a0000", border: "1px solid #f44336",
              borderRadius: 3, color: "#f44336", cursor: "pointer", fontFamily: "inherit", fontSize: 11,
            }}
          >
            ↺ Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
