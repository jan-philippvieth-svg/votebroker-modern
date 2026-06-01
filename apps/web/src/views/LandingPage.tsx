import { BarChart3, ShieldCheck, Zap, ArrowRight, TrendingUp, Users } from "lucide-react";

export function LandingPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#0d1117", color: "#e6edf3", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>

      {/* Nav */}
      <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1.25rem 2rem", borderBottom: "1px solid #21262d", position: "sticky", top: 0, background: "rgba(13,17,23,0.92)", backdropFilter: "blur(8px)", zIndex: 10 }}>
        <span style={{ fontWeight: 700, fontSize: "1.1rem", color: "#58a6ff", letterSpacing: "-0.5px" }}>VoteBroker</span>
        <a href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", background: "#1f6feb", color: "#fff", padding: "0.45rem 1.1rem", borderRadius: "6px", textDecoration: "none", fontSize: "0.875rem", fontWeight: 600 }}>
          Dashboard <ArrowRight size={14} />
        </a>
      </nav>

      {/* Hero */}
      <section style={{ maxWidth: "860px", margin: "0 auto", padding: "5rem 2rem 3rem", textAlign: "center" }}>
        <div style={{ display: "inline-block", background: "#161b22", border: "1px solid #30363d", borderRadius: "99px", padding: "0.3rem 0.9rem", fontSize: "0.78rem", color: "#8b949e", marginBottom: "1.5rem", letterSpacing: "0.5px", textTransform: "uppercase" }}>
          Curation Engine · Steem Blockchain
        </div>
        <h1 style={{ fontSize: "clamp(2rem, 5vw, 3.25rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 1.25rem", color: "#e6edf3", letterSpacing: "-1px" }}>
          Automated Curation.<br />
          <span style={{ color: "#58a6ff" }}>Stable Voting Power.</span>
        </h1>
        <p style={{ fontSize: "1.1rem", color: "#8b949e", lineHeight: 1.7, maxWidth: "620px", margin: "0 auto 2.5rem" }}>
          VoteBroker ist eine intelligente Curation Engine für das Steem-Ökosystem.
          Das System verteilt Votes automatisch, verwaltet Voting Power und ermöglicht
          präzise USD-basierte Vote-Strategien — mit explizitem Consent-Modell.
        </p>
        <div style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
          <a href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", background: "#1f6feb", color: "#fff", padding: "0.75rem 1.75rem", borderRadius: "8px", textDecoration: "none", fontWeight: 700, fontSize: "1rem" }}>
            Dashboard öffnen <ArrowRight size={16} />
          </a>
          <a href="https://github.com/jan-philippvieth-svg/votebroker-modern" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", background: "#21262d", color: "#e6edf3", padding: "0.75rem 1.75rem", borderRadius: "8px", textDecoration: "none", fontWeight: 600, fontSize: "1rem", border: "1px solid #30363d" }}>
            GitHub
          </a>
        </div>
      </section>

      {/* Feature Grid */}
      <section style={{ maxWidth: "960px", margin: "0 auto", padding: "2rem 2rem 4rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1.25rem" }}>

          <FeatureCard
            icon={<Zap size={22} color="#f0883e" />}
            title="USD-genaue Votes"
            body="Wähle einen Zielwert in USD. VoteBroker berechnet das exakte Vote-Gewicht auf Basis aktueller Voting Power und STEEM-Preise."
          />
          <FeatureCard
            icon={<TrendingUp size={22} color="#3fb950" />}
            title="Power-Stable Modus"
            body="Automatische Empfehlung des maximalen Vote-Gewichts, damit die Voting Power langfristig stabil bleibt."
          />
          <FeatureCard
            icon={<ShieldCheck size={22} color="#58a6ff" />}
            title="Explizites Consent-Modell"
            body="Login ist nicht gleich Erlaubnis. Jeder operative Schritt — Vote, Fee-Post, Auto-Vote — wird separat bestätigt und kann jederzeit widerrufen werden."
          />
          <FeatureCard
            icon={<BarChart3 size={22} color="#d2a8ff" />}
            title="Vote-Timing Optimierung"
            body="Automatische Slot-Empfehlung (5–30 Min.) auf Basis historischer Curation-Daten, Risikobewertung und Vertrauens-Score."
          />
          <FeatureCard
            icon={<Users size={22} color="#56d364" />}
            title="Community Pools"
            body="Mehrere Curatoren teilen einen Pool, verteilen Votes fair und sehen gemeinsam Effizienz- und Zuverlässigkeits-Metriken."
          />
          <FeatureCard
            icon={<ArrowRight size={22} color="#ffa657" />}
            title="Transparente Gebühren"
            body="Servicgebühren werden als Vote auf den ausgewiesenen Fee-Post beglichen — kein Token-Transfer, vollständig on-chain nachvollziehbar."
          />
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid #21262d", padding: "1.5rem 2rem", textAlign: "center", color: "#484f58", fontSize: "0.8rem" }}>
        <a href="/dashboard" style={{ color: "#58a6ff", textDecoration: "none", marginRight: "1.5rem" }}>Dashboard</a>
        <a href="/operator" style={{ color: "#58a6ff", textDecoration: "none" }}>Operator</a>
        <span style={{ marginLeft: "1.5rem" }}>© {new Date().getFullYear()} VoteBroker</span>
      </footer>

    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: "10px", padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div style={{ width: "40px", height: "40px", background: "#0d1117", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {icon}
      </div>
      <h3 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700, color: "#e6edf3" }}>{title}</h3>
      <p style={{ margin: 0, fontSize: "0.85rem", color: "#8b949e", lineHeight: 1.65 }}>{body}</p>
    </div>
  );
}
