import React, { useState } from "react";
import {
  ArrowRight, BarChart3, BookOpen, CheckCircle2, Github,
  ShieldCheck, TrendingUp, Users, Zap,
} from "lucide-react";
import { createTranslator, locales, type Locale } from "../i18n";

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

// ── Locale helpers ────────────────────────────────────────────────────────────

function getStoredLocale(): Locale {
  try {
    const v = localStorage.getItem("votebroker.locale") ?? "de";
    return (locales.some(l => l.code === v) ? v : "de") as Locale;
  } catch {
    return "de";
  }
}

// ── Language Switcher ─────────────────────────────────────────────────────────

function LocaleSwitcher({ locale, onChange }: { locale: Locale; onChange: (l: Locale) => void }) {
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value as Locale;
    try { localStorage.setItem("votebroker.locale", v); } catch {}
    onChange(v);
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
      {locales.filter(l => l.code !== "pcm").map(l => (
        <option key={l.code} value={l.code}>{l.label}</option>
      ))}
    </select>
  );
}

// ── Screenshot Tabs ───────────────────────────────────────────────────────────

// Locales with dedicated screenshot sets.
// All other public locales fall back to "en" screenshots — they still appear
// in the dropdown. Extend this set after running capture_landing.py for a locale.
const SCREENSHOT_LOCALES = new Set(["de", "en"]);

function screenshotUrl(name: string, locale: Locale): string {
  const l = SCREENSHOT_LOCALES.has(locale) ? locale : "en";
  return `/api/public/screenshots/${name}-${l}.png`;
}

function ScreenshotSection({ t, locale }: { t: ReturnType<typeof createTranslator>; locale: Locale }) {
  const [active, setActive] = useState("dashboard");

  const SHOTS = [
    { id: "dashboard", label: t("landingTabDashboard"), url: screenshotUrl("dashboard", locale),  caption: t("landingCapDashboard") },
    { id: "dna",       label: t("landingTabDna"),       url: screenshotUrl("vote-dna",  locale),   caption: t("landingCapDna") },
    { id: "community", label: t("landingTabCommunity"), url: screenshotUrl("community", locale),   caption: t("landingCapCommunity") },
  ];

  const shot = SHOTS.find(s => s.id === active)!;

  return (
    <section style={{ maxWidth: "1040px", margin: "0 auto", padding: "4rem 2rem" }}>
      <SectionLabel>{t("landingScreensLabel")}</SectionLabel>
      <h2 style={{ fontSize: "clamp(1.5rem,3.5vw,2.2rem)", fontWeight: 800, color: C.text, margin: "0 0 0.5rem", letterSpacing: "-0.5px" }}>
        {t("landingScreensTitle")}
      </h2>
      <p style={{ color: C.muted, fontSize: "1rem", margin: "0 0 2rem" }}>
        {t("landingScreensSub")}
      </p>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        {SHOTS.map(s => (
          <button key={s.id} onClick={() => setActive(s.id)} style={{
            background: active === s.id ? C.blueDark : C.bg1,
            color: active === s.id ? "#fff" : C.muted,
            border: `1px solid ${active === s.id ? C.blueDark : C.border}`,
            borderRadius: "6px", padding: "0.45rem 1.1rem",
            fontSize: "0.85rem", fontWeight: 600, cursor: "pointer",
          }}>
            {s.label}
          </button>
        ))}
      </div>
      <div style={{ border: `1px solid ${C.border}`, borderRadius: "12px", overflow: "hidden", background: C.bg1, boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
        <img src={shot.url} alt={shot.label} style={{ width: "100%", display: "block" }} loading="lazy" />
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

function FeatureCard({ icon, title, body, accent = C.blue }: { icon: React.ReactNode; title: string; body: string; accent?: string }) {
  return (
    <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "1.5rem", display: "flex", flexDirection: "column" as const, gap: "0.75rem" }}>
      <div style={{ width: "42px", height: "42px", background: accent + "18", borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {icon}
      </div>
      <h3 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700, color: C.text }}>{title}</h3>
      <p style={{ margin: 0, fontSize: "0.85rem", color: C.muted, lineHeight: 1.65 }}>{body}</p>
    </div>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <li style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start", marginBottom: "0.6rem" }}>
      <CheckCircle2 size={16} color={C.green} style={{ marginTop: "0.15rem", flexShrink: 0 }} />
      <span style={{ color: C.muted, fontSize: "0.88rem", lineHeight: 1.6 }}>{text}</span>
    </li>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function LandingPage() {
  const [locale, setLocale] = useState<Locale>(getStoredLocale);
  const t = createTranslator(locale);

  // Respect prefers-reduced-motion: swap animated SVG for static one
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  );
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>

      {/* ── Nav ── */}
      <nav style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "1rem 2rem", borderBottom: `1px solid ${C.border}`,
        position: "sticky", top: 0, background: "rgba(13,17,23,0.92)",
        backdropFilter: "blur(10px)", zIndex: 50,
      }}>
        <img src="/assets/branding/logo/logo-dark.svg" alt="VoteBroker" width={250} style={{ display: "block", height: "auto" }} />
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <LocaleSwitcher locale={locale} onChange={setLocale} />
          <a href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", background: C.blueDark, color: "#fff", padding: "0.4rem 1rem", borderRadius: "6px", textDecoration: "none", fontSize: "0.85rem", fontWeight: 600 }}>
            {t("landingHeroCta")} <ArrowRight size={13} />
          </a>
        </div>
      </nav>

      {/* ── Hero ── */}
      {/* Full-width so the network can bleed right/top without being constrained */}
      <section style={{ width: "100%", padding: "6rem 0 4rem", textAlign: "center", position: "relative", overflow: "hidden" }}>

        {/* Signal network — massive, upper-right, bleeds outside viewport.
            Not a logo. Storytelling: a living intelligence running in the background. */}
        <img
          src={reducedMotion
            ? "/assets/branding/logo/icon.svg"
            : "/assets/branding/logo/icon-animated.svg"}
          alt=""
          aria-hidden
          style={{
            position: "absolute",
            top: "-15%",
            right: "-6%",
            width: "clamp(1100px, 95vw, 1600px)",
            height: "auto",
            opacity: 0.042,
            pointerEvents: "none",
            userSelect: "none",
            zIndex: 0,
          }}
        />

        {/* Content — constrained width, always above background */}
        <div style={{ maxWidth: "860px", margin: "0 auto", padding: "0 2rem", position: "relative", zIndex: 1 }}>
          <div style={{ display: "inline-block", background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "99px", padding: "0.3rem 1rem", fontSize: "0.75rem", color: C.muted, marginBottom: "1.75rem", letterSpacing: "0.5px", textTransform: "uppercase" as const }}>
            {t("landingHeroBadge")}
          </div>
          <h1 style={{ fontSize: "clamp(2rem,5.5vw,3.5rem)", fontWeight: 800, lineHeight: 1.12, margin: "0 0 1.25rem", color: C.text, letterSpacing: "-1.5px" }}>
            {t("landingHeroTitle").split(". ").map((part, i, arr) => (
              <React.Fragment key={i}>
                {i === arr.length - 1
                  ? <span style={{ color: C.blue }}>{part}</span>
                  : <>{part}.<br /></>}
              </React.Fragment>
            ))}
          </h1>
          <p style={{ fontSize: "1.1rem", color: C.muted, lineHeight: 1.75, maxWidth: "600px", margin: "0 auto 2.5rem" }}>
            {t("landingHeroSubtitle")}
          </p>
          <div style={{ display: "flex", gap: "0.875rem", justifyContent: "center", flexWrap: "wrap" }}>
            <a href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", background: C.blueDark, color: "#fff", padding: "0.8rem 1.75rem", borderRadius: "8px", textDecoration: "none", fontWeight: 700, fontSize: "1rem" }}>
              {t("landingHeroCta")} <ArrowRight size={16} />
            </a>
            <a href="https://github.com/jan-philippvieth-svg/votebroker-modern" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", background: C.bg1, color: C.text, padding: "0.8rem 1.75rem", borderRadius: "8px", textDecoration: "none", fontWeight: 600, fontSize: "1rem", border: `1px solid ${C.border}` }}>
              <Github size={16} /> GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── Warum VoteBroker? ── */}
      <section style={{ maxWidth: "1040px", margin: "0 auto", padding: "4rem 2rem" }}>
        <SectionLabel>{t("landingWhyLabel")}</SectionLabel>
        <h2 style={{ fontSize: "clamp(1.5rem,3.5vw,2.2rem)", fontWeight: 800, color: C.text, margin: "0 0 0.5rem", letterSpacing: "-0.5px" }}>
          {t("landingWhyTitle")}
        </h2>
        <p style={{ color: C.muted, fontSize: "1rem", maxWidth: "560px", lineHeight: 1.7, margin: "0 0 2.5rem" }}>
          {t("landingWhySub")}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1.25rem" }}>
          <FeatureCard icon={<TrendingUp size={20} color={C.green}  />} accent={C.green}  title={t("landingFeat1Title")} body={t("landingFeat1Text")} />
          <FeatureCard icon={<Zap         size={20} color={C.orange} />} accent={C.orange} title={t("landingFeat2Title")} body={t("landingFeat2Text")} />
          <FeatureCard icon={<ShieldCheck size={20} color={C.blue}   />} accent={C.blue}   title={t("landingFeat3Title")} body={t("landingFeat3Text")} />
          <FeatureCard icon={<BarChart3   size={20} color={C.purple} />} accent={C.purple} title={t("landingFeat4Title")} body={t("landingFeat4Text")} />
          <FeatureCard icon={<Users       size={20} color={C.green}  />} accent={C.green}  title={t("landingFeat5Title")} body={t("landingFeat5Text")} />
          <FeatureCard icon={<BookOpen    size={20} color={C.yellow} />} accent={C.yellow} title={t("landingFeat6Title")} body={t("landingFeat6Text")} />
        </div>
      </section>

      {/* ── Screenshots ── */}
      <div style={{ background: C.bg1, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <ScreenshotSection t={t} locale={locale} />
      </div>

      {/* ── Vote-DNA erklärt ── */}
      <section style={{ maxWidth: "1040px", margin: "0 auto", padding: "4rem 2rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "3rem", alignItems: "center" }}>
          <div>
            <SectionLabel>{t("landingDnaLabel")}</SectionLabel>
            <h2 style={{ fontSize: "clamp(1.4rem,3vw,2rem)", fontWeight: 800, color: C.text, margin: "0 0 1rem", letterSpacing: "-0.5px" }}>
              {t("landingDnaTitle")}
            </h2>
            <p style={{ color: C.muted, lineHeight: 1.75, margin: "0 0 1.25rem" }}>{t("landingDnaText")}</p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              <Bullet text={t("landingDnaBullet1")} />
              <Bullet text={t("landingDnaBullet2")} />
              <Bullet text={t("landingDnaBullet3")} />
              <Bullet text={t("landingDnaBullet4")} />
            </ul>
          </div>
          <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "12px", overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,0.3)" }}>
            <img src={screenshotUrl("vote-dna", locale)} alt="Vote-DNA" style={{ width: "100%", display: "block" }} loading="lazy" />
          </div>
        </div>
      </section>

      {/* ── Community Intelligence ── */}
      <div style={{ background: C.bg1, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <section style={{ maxWidth: "1040px", margin: "0 auto", padding: "4rem 2rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "3rem", alignItems: "center" }}>
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: "12px", overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,0.3)" }}>
              <img src={screenshotUrl("community", locale)} alt="Community" style={{ width: "100%", display: "block" }} loading="lazy" />
            </div>
            <div>
              <SectionLabel>{t("landingComLabel")}</SectionLabel>
              <h2 style={{ fontSize: "clamp(1.4rem,3vw,2rem)", fontWeight: 800, color: C.text, margin: "0 0 1rem", letterSpacing: "-0.5px" }}>
                {t("landingComTitle")}
              </h2>
              <p style={{ color: C.muted, lineHeight: 1.75, margin: "0 0 1.25rem" }}>{t("landingComText")}</p>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                <Bullet text={t("landingComBullet1")} />
                <Bullet text={t("landingComBullet2")} />
                <Bullet text={t("landingComBullet3")} />
                <Bullet text={t("landingComBullet4")} />
              </ul>
            </div>
          </div>
        </section>
      </div>

      {/* ── Consent & Sicherheit ── */}
      <section style={{ maxWidth: "760px", margin: "0 auto", padding: "4rem 2rem", textAlign: "center" }}>
        <SectionLabel>{t("landingConLabel")}</SectionLabel>
        <h2 style={{ fontSize: "clamp(1.4rem,3vw,2rem)", fontWeight: 800, color: C.text, margin: "0 0 0.75rem", letterSpacing: "-0.5px" }}>
          {t("landingConTitle")}
        </h2>
        <p style={{ color: C.muted, lineHeight: 1.75, maxWidth: "540px", margin: "0 auto 2.5rem" }}>
          {t("landingConText")}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", textAlign: "left" }}>
          {([1,2,3,4] as const).map(i => (
            <div key={i} style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "1.1rem 1.25rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
                <ShieldCheck size={14} color={C.green} />
                <span style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text }}>{t(`landingCon${i}Title` as Parameters<typeof t>[0])}</span>
              </div>
              <p style={{ margin: 0, fontSize: "0.78rem", color: C.muted, lineHeight: 1.5 }}>{t(`landingCon${i}Desc` as Parameters<typeof t>[0])}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Open Source / GitHub ── */}
      <div style={{ background: C.bg1, borderTop: `1px solid ${C.border}` }}>
        <section style={{ maxWidth: "860px", margin: "0 auto", padding: "4rem 2rem", textAlign: "center" }}>
          <Github size={36} color={C.muted} style={{ marginBottom: "1.25rem" }} />
          <h2 style={{ fontSize: "clamp(1.4rem,3vw,2rem)", fontWeight: 800, color: C.text, margin: "0 0 0.75rem", letterSpacing: "-0.5px" }}>
            {t("landingOssTitle")}
          </h2>
          <p style={{ color: C.muted, lineHeight: 1.75, maxWidth: "520px", margin: "0 auto 2rem" }}>
            {t("landingOssText")}
          </p>
          <a href="https://github.com/jan-philippvieth-svg/votebroker-modern" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", background: C.bg, color: C.text, padding: "0.75rem 1.75rem", borderRadius: "8px", textDecoration: "none", fontWeight: 600, fontSize: "0.95rem", border: `1px solid ${C.border}` }}>
            <Github size={16} /> {t("landingOssCta")}
          </a>
        </section>
      </div>

      {/* ── Footer ── */}
      <footer style={{ borderTop: `1px solid ${C.border}`, padding: "1.5rem 2rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem", color: C.dim, fontSize: "0.8rem" }}>
        <img src="/assets/branding/logo/icon.svg" alt="VoteBroker" height={20} style={{ display: "block" }} />
        <div style={{ display: "flex", gap: "1.5rem" }}>
          <a href="/dashboard" style={{ color: C.muted, textDecoration: "none" }}>{t("landingHeroCta")}</a>
          <a href="/operator"  style={{ color: C.muted, textDecoration: "none" }}>Operator</a>
          <a href="https://github.com/jan-philippvieth-svg/votebroker-modern" target="_blank" rel="noopener noreferrer" style={{ color: C.muted, textDecoration: "none" }}>GitHub</a>
        </div>
        <span>© {new Date().getFullYear()} VoteBroker</span>
      </footer>

    </div>
  );
}
