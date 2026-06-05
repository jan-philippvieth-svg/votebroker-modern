import React, { useState } from "react";
import {
  ArrowRight, BarChart3, BookOpen, CheckCircle2, Github,
  ShieldCheck, TrendingUp, Users, Zap,
} from "lucide-react";

// ── Design tokens ─────────────────────────────────────────────────────────────

const C = {
  bg:       "#0d1117",
  bg1:      "#161b22",
  bg2:      "#21262d",
  border:   "#30363d",
  text:     "#e6edf3",
  muted:    "#8b949e",
  dim:      "#484f58",
  blue:     "#58a6ff",
  blueDark: "#1f6feb",
  green:    "#3fb950",
  orange:   "#f0883e",
  purple:   "#d2a8ff",
  yellow:   "#e3b341",
};

const LOCALES = [
  { code: "de",  label: "Deutsch" },
  { code: "en",  label: "English" },
  { code: "es",  label: "Español" },
  { code: "pt",  label: "Português" },
  { code: "id",  label: "Indonesia" },
  { code: "ru",  label: "Русский" },
  { code: "ko",  label: "한국어" },
  { code: "zh",  label: "中文" },
  { code: "ja",  label: "日本語" },
  { code: "hi",  label: "हिन्दी" },
  { code: "bn",  label: "বাংলা" },
  { code: "tr",  label: "Türkçe" },
  { code: "pl",  label: "Polski" },
  { code: "pcm", label: "Naija" },
];

// ── Language Switcher ─────────────────────────────────────────────────────────

function LocaleSwitcher() {
  const stored = typeof localStorage !== "undefined"
    ? (localStorage.getItem("votebroker.locale") ?? "de") : "de";
  const [locale, setLocale] = useState(stored);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    setLocale(v);
    localStorage.setItem("votebroker.locale", v);
  }

  return (
    <select
      value={locale}
      onChange={handleChange}
      style={{
        background: C.bg1, color: C.muted, border: `1px solid ${C.border}`,
        borderRadius: "6px", padding: "0.3rem 0.6rem", fontSize: "0.8rem",
        cursor: "pointer", outline: "none",
      }}
      title="Sprache / Language"
    >
      {LOCALES.map(l => (
        <option key={l.code} value={l.code}>{l.label}</option>
      ))}
    </select>
  );
}

// ── Screenshot Tabs ───────────────────────────────────────────────────────────

const SCREENSHOTS = [
  {
    id: "dashboard",
    label: "Dashboard",
    url: "/api/public/screenshots/dashboard.png",
    caption: "Voting Power, Curation-Ergebnis und tägliche Statistik auf einen Blick",
  },
  {
    id: "dna",
    label: "Vote-DNA",
    url: "/api/public/screenshots/vote-dna.png",
    caption: "Offene Posts scannen, Vote-Plan generieren und Gewichte präzise setzen",
  },
  {
    id: "community",
    label: "Community",
    url: "/api/public/screenshots/community.png",
    caption: "Autor-Radar, Whale-Signale und Trust Scores für smarte Curation",
  },
];

function ScreenshotSection() {
  const [active, setActive] = useState("dashboard");
  const shot = SCREENSHOTS.find(s => s.id === active)!;

  return (
    <section style={{ maxWidth: "1040px", margin: "0 auto", padding: "4rem 2rem" }}>
      <SectionLabel>Live-Screenshots</SectionLabel>
      <h2 style={{ fontSize: "clamp(1.5rem,3.5vw,2.2rem)", fontWeight: 800, color: C.text, margin: "0 0 0.5rem", letterSpacing: "-0.5px" }}>
        Sieh, was du bekommst
      </h2>
      <p style={{ color: C.muted, fontSize: "1rem", margin: "0 0 2rem" }}>
        Echte Screenshots aus der laufenden Produktionsinstanz.
      </p>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        {SCREENSHOTS.map(s => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            style={{
              background: active === s.id ? C.blueDark : C.bg1,
              color: active === s.id ? "#fff" : C.muted,
              border: `1px solid ${active === s.id ? C.blueDark : C.border}`,
              borderRadius: "6px", padding: "0.45rem 1.1rem",
              fontSize: "0.85rem", fontWeight: 600,
              cursor: "pointer", transition: "all 0.15s",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Screenshot */}
      <div style={{
        border: `1px solid ${C.border}`, borderRadius: "12px", overflow: "hidden",
        background: C.bg1, boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }}>
        <img
          src={shot.url}
          alt={shot.label}
          style={{ width: "100%", display: "block" }}
          loading="lazy"
        />
      </div>
      <p style={{ color: C.muted, fontSize: "0.85rem", marginTop: "0.75rem", textAlign: "center" }}>
        {shot.caption}
      </p>
    </section>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "inline-block", background: C.bg1, border: `1px solid ${C.border}`,
      borderRadius: "99px", padding: "0.25rem 0.85rem",
      fontSize: "0.72rem", color: C.muted, marginBottom: "1rem",
      letterSpacing: "0.5px", textTransform: "uppercase" as const,
    }}>
      {children}
    </div>
  );
}

function FeatureCard({
  icon, title, body, accent = C.blue,
}: { icon: React.ReactNode; title: string; body: string; accent?: string }) {
  return (
    <div style={{
      background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "12px",
      padding: "1.5rem", display: "flex", flexDirection: "column" as const, gap: "0.75rem",
      transition: "border-color 0.2s",
    }}>
      <div style={{
        width: "42px", height: "42px", background: accent + "18", borderRadius: "10px",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {icon}
      </div>
      <h3 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700, color: C.text }}>{title}</h3>
      <p style={{ margin: 0, fontSize: "0.85rem", color: C.muted, lineHeight: 1.65 }}>{body}</p>
    </div>
  );
}

function ConsentItem({ text }: { text: string }) {
  return (
    <li style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start", marginBottom: "0.6rem" }}>
      <CheckCircle2 size={16} color={C.green} style={{ marginTop: "0.15rem", flexShrink: 0 }} />
      <span style={{ color: C.muted, fontSize: "0.88rem", lineHeight: 1.6 }}>{text}</span>
    </li>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function LandingPage() {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>

      {/* ── Nav ── */}
      <nav style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "1rem 2rem", borderBottom: `1px solid ${C.border}`,
        position: "sticky", top: 0, background: "rgba(13,17,23,0.92)",
        backdropFilter: "blur(10px)", zIndex: 50,
      }}>
        <span style={{ fontWeight: 800, fontSize: "1.05rem", color: C.blue, letterSpacing: "-0.5px" }}>
          VoteBroker
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <LocaleSwitcher />
          <a
            href="/dashboard"
            style={{
              display: "inline-flex", alignItems: "center", gap: "0.4rem",
              background: C.blueDark, color: "#fff",
              padding: "0.4rem 1rem", borderRadius: "6px",
              textDecoration: "none", fontSize: "0.85rem", fontWeight: 600,
            }}
          >
            Dashboard <ArrowRight size={13} />
          </a>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section style={{ maxWidth: "860px", margin: "0 auto", padding: "6rem 2rem 4rem", textAlign: "center" }}>
        <div style={{
          display: "inline-block", background: C.bg1, border: `1px solid ${C.border}`,
          borderRadius: "99px", padding: "0.3rem 1rem", fontSize: "0.75rem",
          color: C.muted, marginBottom: "1.75rem", letterSpacing: "0.5px",
          textTransform: "uppercase" as const,
        }}>
          Curation Engine · Steem Blockchain
        </div>
        <h1 style={{
          fontSize: "clamp(2rem,5.5vw,3.5rem)", fontWeight: 800, lineHeight: 1.12,
          margin: "0 0 1.25rem", color: C.text, letterSpacing: "-1.5px",
        }}>
          Smarter Curating.<br />
          <span style={{ color: C.blue }}>Stable Voting Power.</span>
        </h1>
        <p style={{ fontSize: "1.1rem", color: C.muted, lineHeight: 1.75, maxWidth: "600px", margin: "0 auto 2.5rem" }}>
          VoteBroker ist eine Curation Engine für das Steem-Ökosystem.
          Automatische Vote-Verteilung, präzise USD-Strategien und ein explizites
          Consent-Modell — für Curatoren die Kontrolle wollen.
        </p>
        <div style={{ display: "flex", gap: "0.875rem", justifyContent: "center", flexWrap: "wrap" }}>
          <a href="/dashboard" style={{
            display: "inline-flex", alignItems: "center", gap: "0.5rem",
            background: C.blueDark, color: "#fff",
            padding: "0.8rem 1.75rem", borderRadius: "8px",
            textDecoration: "none", fontWeight: 700, fontSize: "1rem",
          }}>
            Dashboard öffnen <ArrowRight size={16} />
          </a>
          <a
            href="https://github.com/jan-philippvieth-svg/votebroker-modern"
            target="_blank" rel="noopener noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: "0.5rem",
              background: C.bg1, color: C.text,
              padding: "0.8rem 1.75rem", borderRadius: "8px",
              textDecoration: "none", fontWeight: 600, fontSize: "1rem",
              border: `1px solid ${C.border}`,
            }}
          >
            <Github size={16} /> GitHub
          </a>
        </div>
      </section>

      {/* ── Warum VoteBroker? ── */}
      <section style={{ maxWidth: "1040px", margin: "0 auto", padding: "4rem 2rem" }}>
        <SectionLabel>Warum VoteBroker?</SectionLabel>
        <h2 style={{ fontSize: "clamp(1.5rem,3.5vw,2.2rem)", fontWeight: 800, color: C.text, margin: "0 0 0.5rem", letterSpacing: "-0.5px" }}>
          Nicht nur ein Vote-Bot
        </h2>
        <p style={{ color: C.muted, fontSize: "1rem", maxWidth: "560px", lineHeight: 1.7, margin: "0 0 2.5rem" }}>
          Die meisten Curation-Tools geben dir eine Liste und einen Knopf.
          VoteBroker gibt dir ein System.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1.25rem" }}>
          <FeatureCard
            icon={<TrendingUp size={20} color={C.green} />}
            accent={C.green}
            title="USD-genaue Vote-Strategien"
            body="Setze einen Zielwert in USD. VoteBroker berechnet das exakte Vote-Gewicht auf Basis aktueller Voting Power und STEEM-Preise — kein Raten mehr."
          />
          <FeatureCard
            icon={<Zap size={20} color={C.orange} />}
            accent={C.orange}
            title="Power-Stable Modus"
            body="Automatische Empfehlung des maximalen Vote-Gewichts, damit deine Voting Power langfristig im grünen Bereich bleibt."
          />
          <FeatureCard
            icon={<ShieldCheck size={20} color={C.blue} />}
            accent={C.blue}
            title="Explizites Consent-Modell"
            body='Login ≠ Erlaubnis. Jeder operative Schritt — Vote, Fee, Auto-Vote — wird separat bestätigt. Du entscheidest, was passiert.'
          />
          <FeatureCard
            icon={<BarChart3 size={20} color={C.purple} />}
            accent={C.purple}
            title="Timing-Intelligenz"
            body="Slot-Empfehlung (5–30 Min.) auf Basis historischer Curation-Daten, Risikobewertung und Vertrauens-Score aus echten Blockchain-Transaktionen."
          />
          <FeatureCard
            icon={<Users size={20} color={C.green} />}
            accent={C.green}
            title="Community Pools"
            body="Mehrere Curatoren teilen einen Pool, verteilen Votes fair und sehen gemeinsam Effizienz- und Zuverlässigkeits-Metriken."
          />
          <FeatureCard
            icon={<BookOpen size={20} color={C.yellow} />}
            accent={C.yellow}
            title="Transparente Gebühren"
            body="Service-Gebühren werden als Vote auf einen ausgewiesenen Fee-Post beglichen — kein Token-Transfer, vollständig on-chain nachvollziehbar."
          />
        </div>
      </section>

      {/* ── Screenshots ── */}
      <div style={{ background: C.bg1, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <ScreenshotSection />
      </div>

      {/* ── Vote-DNA erklärt ── */}
      <section style={{ maxWidth: "1040px", margin: "0 auto", padding: "4rem 2rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "3rem", alignItems: "center" }}>
          <div>
            <SectionLabel>Vote-DNA</SectionLabel>
            <h2 style={{ fontSize: "clamp(1.4rem,3vw,2rem)", fontWeight: 800, color: C.text, margin: "0 0 1rem", letterSpacing: "-0.5px" }}>
              Der optimale Vote.<br />Zur richtigen Zeit.
            </h2>
            <p style={{ color: C.muted, lineHeight: 1.75, margin: "0 0 1.25rem" }}>
              Vote-DNA analysiert historische Curation-Daten aus der Blockchain und ermittelt
              für jeden Post den optimalen Zeitpunkt und das optimale Gewicht.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {[
                "Offene Posts automatisch scannen und nach Potential sortieren",
                "Vote-Plan mit USD-Zielwert in Sekunden generieren",
                "Einzelne Gewichte anpassen bevor der Plan abgesendet wird",
                "Timing-Empfehlung auf Basis historischer Curation-Rewards",
              ].map(t => <ConsentItem key={t} text={t} />)}
            </ul>
          </div>
          <div style={{
            background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "12px",
            overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
          }}>
            <img
              src="/api/public/screenshots/vote-dna.png"
              alt="Vote-DNA Screenshot"
              style={{ width: "100%", display: "block" }}
              loading="lazy"
            />
          </div>
        </div>
      </section>

      {/* ── Community Intelligence ── */}
      <div style={{ background: C.bg1, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <section style={{ maxWidth: "1040px", margin: "0 auto", padding: "4rem 2rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "3rem", alignItems: "center" }}>
            <div style={{
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: "12px",
              overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
            }}>
              <img
                src="/api/public/screenshots/community.png"
                alt="Community Screenshot"
                style={{ width: "100%", display: "block" }}
                loading="lazy"
              />
            </div>
            <div>
              <SectionLabel>Community Intelligence</SectionLabel>
              <h2 style={{ fontSize: "clamp(1.4rem,3vw,2rem)", fontWeight: 800, color: C.text, margin: "0 0 1rem", letterSpacing: "-0.5px" }}>
                Entdecke.<br />Verstehe. Curate.
              </h2>
              <p style={{ color: C.muted, lineHeight: 1.75, margin: "0 0 1.25rem" }}>
                Der Community-Tab kombiniert Blockchain-Analyse mit
                Whale-Intelligence — und zeigt dir, wer die wirklich interessanten
                Autoren in deiner Community sind.
              </p>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {[
                  "Autor-Radar: Neue Autoren mit echtem Potential entdecken",
                  "Whale-Signale: Welchen Accounts folgen große SP-Holder?",
                  "Trust Scores aus historischen Curation-Daten",
                  "Community Pools für kollaborative Curation",
                ].map(t => <ConsentItem key={t} text={t} />)}
              </ul>
            </div>
          </div>
        </section>
      </div>

      {/* ── Consent & Sicherheit ── */}
      <section style={{ maxWidth: "760px", margin: "0 auto", padding: "4rem 2rem", textAlign: "center" }}>
        <SectionLabel>Consent & Sicherheit</SectionLabel>
        <h2 style={{ fontSize: "clamp(1.4rem,3vw,2rem)", fontWeight: 800, color: C.text, margin: "0 0 0.75rem", letterSpacing: "-0.5px" }}>
          Du behältst die Kontrolle.
        </h2>
        <p style={{ color: C.muted, lineHeight: 1.75, maxWidth: "540px", margin: "0 auto 2.5rem" }}>
          VoteBroker handelt nur mit deiner expliziten Erlaubnis.
          Kein implizites Opt-in. Jede Berechtigung kann jederzeit einzeln widerrufen werden.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", textAlign: "left" }}>
          {[
            { label: "Vote absenden",        desc: "Nur nach Bestätigung des Vote-Plans" },
            { label: "Auto-Vote aktivieren", desc: "Separates Opt-in für automatische Votes" },
            { label: "Fee-Post erstellen",   desc: "Explizite Zustimmung vor jedem Fee-Event" },
            { label: "Session & Token",      desc: "Nur im lokalen Store — nie serverseitig gespeichert" },
          ].map(({ label, desc }) => (
            <div key={label} style={{
              background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "10px",
              padding: "1.1rem 1.25rem",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
                <ShieldCheck size={14} color={C.green} />
                <span style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text }}>{label}</span>
              </div>
              <p style={{ margin: 0, fontSize: "0.78rem", color: C.muted, lineHeight: 1.5 }}>{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Open Source / GitHub ── */}
      <div style={{ background: C.bg1, borderTop: `1px solid ${C.border}` }}>
        <section style={{ maxWidth: "860px", margin: "0 auto", padding: "4rem 2rem", textAlign: "center" }}>
          <Github size={36} color={C.muted} style={{ marginBottom: "1.25rem" }} />
          <h2 style={{ fontSize: "clamp(1.4rem,3vw,2rem)", fontWeight: 800, color: C.text, margin: "0 0 0.75rem", letterSpacing: "-0.5px" }}>
            Open Source
          </h2>
          <p style={{ color: C.muted, lineHeight: 1.75, maxWidth: "520px", margin: "0 auto 2rem" }}>
            VoteBroker ist vollständig Open Source. Kein Vendor-Lock-in,
            keine Black Box. Der gesamte Stack — API, Frontend, Blockchain-Integration — liegt offen.
          </p>
          <a
            href="https://github.com/jan-philippvieth-svg/votebroker-modern"
            target="_blank" rel="noopener noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: "0.5rem",
              background: C.bg, color: C.text,
              padding: "0.75rem 1.75rem", borderRadius: "8px",
              textDecoration: "none", fontWeight: 600, fontSize: "0.95rem",
              border: `1px solid ${C.border}`,
            }}
          >
            <Github size={16} /> Code auf GitHub ansehen
          </a>
        </section>
      </div>

      {/* ── Footer ── */}
      <footer style={{
        borderTop: `1px solid ${C.border}`, padding: "1.5rem 2rem",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: "0.75rem",
        color: C.dim, fontSize: "0.8rem",
      }}>
        <span style={{ fontWeight: 700, color: C.blue }}>VoteBroker</span>
        <div style={{ display: "flex", gap: "1.5rem" }}>
          <a href="/dashboard" style={{ color: C.muted, textDecoration: "none" }}>Dashboard</a>
          <a href="/operator" style={{ color: C.muted, textDecoration: "none" }}>Operator</a>
          <a href="https://github.com/jan-philippvieth-svg/votebroker-modern" target="_blank" rel="noopener noreferrer" style={{ color: C.muted, textDecoration: "none" }}>GitHub</a>
        </div>
        <span>© {new Date().getFullYear()} VoteBroker</span>
      </footer>

    </div>
  );
}
