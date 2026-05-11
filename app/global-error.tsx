"use client";

/**
 * Top-level React error boundary. Triggered when a server-component render,
 * a route layout, or any unhandled exception bubbles up past every page-level
 * boundary. Shows a brief recovery affordance instead of a white screen.
 *
 * Per Next.js App Router contract this MUST live at app/global-error.tsx,
 * MUST render <html><body>, and MUST be a client component.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f8fafc" }}>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
          <div
            style={{
              maxWidth: 480,
              background: "#fff",
              borderRadius: 16,
              padding: 32,
              boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
            <h1 style={{ margin: 0, fontSize: 22, color: "#0f172a" }}>Something went wrong</h1>
            <p style={{ margin: "12px 0 0", fontSize: 14, color: "#475569" }}>
              An unexpected error occurred. You can try again or head back to the homepage.
            </p>
            {error.digest && (
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
                Reference: {error.digest}
              </p>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 24 }}>
              <button
                type="button"
                onClick={() => reset()}
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: "1px solid #10b981",
                  background: "#10b981",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
              <a
                href="/"
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                  color: "#0f172a",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                Go home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
