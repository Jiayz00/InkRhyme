import "./index.css";
import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

class StudioErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error: string | null }> {
  override state: { readonly error: string | null } = { error: null };

  static getDerivedStateFromError(err: unknown): { readonly error: string } {
    const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
    const stack = err instanceof Error ? err.stack ?? "" : "";
    return { error: `${message}\n${stack}`.trim() };
  }

  override componentDidCatch(err: unknown, info: unknown): void {
    // Keep console as the authoritative crash channel so the user can
    // report full traces. Never swallow.
    // eslint-disable-next-line no-console
    console.error("[Studio ErrorBoundary] crash:", err, info);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: "100vh",
          background: "#0f172a",
          color: "#f1f5f9",
          fontFamily: "system-ui, sans-serif",
          padding: "48px 16px",
          display: "flex",
          justifyContent: "center",
        }}>
          <div style={{
            maxWidth: 760,
            width: "100%",
            background: "#1e293b",
            border: "1px solid rgba(248, 113, 113, 0.3)",
            borderRadius: 16,
            padding: 24,
          }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "#fecaca" }}>
              Studio 启动时崩溃 / Studio crashed while rendering
            </h1>
            <p style={{ marginTop: 16, fontSize: 14, color: "#cbd5e1", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
              {this.state.error}
            </p>
            <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
              <button
                type="button"
                onClick={this.handleReset}
                style={{
                  background: "#f97316",
                  color: "#fff",
                  border: 0,
                  padding: "8px 16px",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                重试 Reload
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{
                  background: "transparent",
                  color: "#cbd5e1",
                  border: "1px solid rgba(203, 213, 225, 0.3)",
                  padding: "8px 16px",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                刷新页面 Refresh page
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StudioErrorBoundary>
      <App />
    </StudioErrorBoundary>
  </StrictMode>,
);
