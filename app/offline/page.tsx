// /offline — minimal shell served by the service worker when the
// network is unreachable and the requested page has not been visited
// yet (so no cache entry exists for it). Static, no JS dependencies,
// no auth state references — safe to render to any signed-in or
// signed-out user without leaking dashboard chrome.

export const metadata = {
  title: "Offline — BloomIQ",
  robots: { index: false },
};

export default function OfflinePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#f8fafc",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 420,
          background: "#fff",
          borderRadius: 16,
          padding: 32,
          boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 48, marginBottom: 12 }}>📡</div>
        <h1 style={{ margin: 0, fontSize: 22, color: "#0f172a" }}>You&apos;re offline</h1>
        <p style={{ margin: "12px 0 0", fontSize: 14, color: "#475569" }}>
          BloomIQ couldn&apos;t reach the internet. Reconnect, then refresh
          this tab to pick up where you left off.
        </p>
      </div>
    </main>
  );
}
