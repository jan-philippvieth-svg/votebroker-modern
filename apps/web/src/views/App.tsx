import {
  AlertTriangle,
  BadgeDollarSign,
  BarChart3,
  CheckCircle2,
  Gauge,
  LineChart,
  Send,
  ShieldCheck,
  TrendingUp,
  WalletCards
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  completeSteemConnectLogin,
  getConsentCatalog,
  getConsentState,
  getSteemConnectUrl,
  grantConsent,
  quoteVote,
  revokeConsent,
  signOut,
  type AuthSession,
  type ConsentRecord,
  type ConsentState,
  type ConsentType,
  type VoteQuoteResponse
} from "../api";

const statusLabel = {
  active: "Aktiv",
  warning: "Warnung",
  paused: "Pausiert",
  payment_required: "Freischaltung noetig"
};

const dashboardStats = {
  totalCuratedUsd: 42.0,
  activeVoteUsd: 18.75,
  feeUsd: 1.26,
  pendingFeesUsd: 0.08,
  feeCoverage: 96,
  votingPowerHealth: 78,
  curationEfficiency: 33.3
};

const curationSeries = [
  { day: "Mo", curated: 4.2, fees: 0.13, power: 86 },
  { day: "Di", curated: 6.8, fees: 0.2, power: 82 },
  { day: "Mi", curated: 5.4, fees: 0.16, power: 77 },
  { day: "Do", curated: 8.2, fees: 0.25, power: 72 },
  { day: "Fr", curated: 7.1, fees: 0.21, power: 80 },
  { day: "Sa", curated: 5.9, fees: 0.18, power: 84 },
  { day: "So", curated: 4.4, fees: 0.13, power: 78 }
];

const voteFlow = [
  { label: "Active votes", value: "$18.75", color: "teal" },
  { label: "Covered fees", value: "$1.18", color: "green" },
  { label: "Pending fees", value: "$0.08", color: "yellow" },
  { label: "Paused risk", value: "Low", color: "orange" }
];

export function App() {
  const [session, setSession] = useState<AuthSession | null>(() => {
    const raw = window.localStorage.getItem("votebroker.session");
    return raw ? JSON.parse(raw) as AuthSession : null;
  });
  const [username, setUsername] = useState("demo");
  const [author, setAuthor] = useState("authorname");
  const [permlink, setPermlink] = useState("example-post");
  const [desiredVoteUsd, setDesiredVoteUsd] = useState(2.5);
  const [result, setResult] = useState<VoteQuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [consentCatalog, setConsentCatalog] = useState<ConsentRecord[]>([]);
  const [consentState, setConsentState] = useState<ConsentState | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [consentLoading, setConsentLoading] = useState<ConsentType | null>(null);

  useEffect(() => {
    getConsentCatalog()
      .then(setConsentCatalog)
      .catch((err) => setConsentError(err instanceof Error ? err.message : "Consent-Katalog konnte nicht geladen werden"));
  }, []);

  useEffect(() => {
    if (!session) {
      setConsentState(null);
      return;
    }

    getConsentState(session.token)
      .then(setConsentState)
      .catch((err) => setConsentError(err instanceof Error ? err.message : "Consent-Status konnte nicht geladen werden"));
  }, [session]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) {
      return;
    }

    setAuthLoading(true);
    completeSteemConnectLogin(code)
      .then((nextSession) => {
        setSession(nextSession);
        setUsername(nextSession.user.username);
        window.localStorage.setItem("votebroker.session", JSON.stringify(nextSession));
        url.searchParams.delete("code");
        url.searchParams.delete("state");
        window.history.replaceState({}, document.title, url.pathname + url.search);
      })
      .catch((err) => setAuthError(err instanceof Error ? err.message : "Login fehlgeschlagen"))
      .finally(() => setAuthLoading(false));
  }, []);

  const votePercent = useMemo(() => {
    if (!result) return "0.00";
    return (result.quote.voteWeightBps / 100).toFixed(2);
  }, [result]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const quote = await quoteVote({ username, author, permlink, desiredVoteUsd });
      setResult(quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unbekannter Fehler");
    } finally {
      setLoading(false);
    }
  }

  async function connectSteem() {
    setAuthLoading(true);
    setAuthError(null);

    try {
      const url = await getSteemConnectUrl();
      window.location.assign(url);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Login konnte nicht gestartet werden");
      setAuthLoading(false);
    }
  }

  async function disconnect() {
    if (session) {
      await signOut(session.token);
    }
    setSession(null);
    window.localStorage.removeItem("votebroker.session");
  }

  async function updateConsent(type: ConsentType, action: "grant" | "revoke") {
    if (!session) {
      setConsentError("Bitte zuerst mit SteemConnect verbinden.");
      return;
    }

    setConsentLoading(type);
    setConsentError(null);
    try {
      const nextState = action === "grant"
        ? await grantConsent(session.token, type)
        : await revokeConsent(session.token, type);
      setConsentState(nextState);
    } catch (err) {
      setConsentError(err instanceof Error ? err.message : "Consent konnte nicht aktualisiert werden");
    } finally {
      setConsentLoading(null);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">VoteBroker</p>
          <h1>Curation Dashboard</h1>
        </div>
        <div className="status-pill">
          <CheckCircle2 size={16} />
          Fee-vote billing
        </div>
      </header>

      <AuthBar
        authError={authError}
        authLoading={authLoading}
        onConnect={connectSteem}
        onDisconnect={disconnect}
        session={session}
      />

      <ConsentPanel
        catalog={consentCatalog}
        consentError={consentError}
        loadingType={consentLoading}
        onGrant={(type) => updateConsent(type, "grant")}
        onRevoke={(type) => updateConsent(type, "revoke")}
        session={session}
        state={consentState}
      />

      <Dashboard />

      <section className="workspace">
        <form className="panel vote-form" onSubmit={submit}>
          <div className="panel-title">
            <BadgeDollarSign size={20} />
            <h2>Vote erstellen</h2>
          </div>

          <label>
            Account
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>

          <div className="field-grid">
            <label>
              Autor
              <input value={author} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <label>
              Permlink
              <input value={permlink} onChange={(event) => setPermlink(event.target.value)} />
            </label>
          </div>

          <label>
            Zielwert in USD
            <input
              min="0.01"
              step="0.01"
              type="number"
              value={desiredVoteUsd}
              onChange={(event) => setDesiredVoteUsd(Number(event.target.value))}
            />
          </label>

          <button disabled={loading} type="submit">
            <Send size={16} />
            {loading ? "Berechne..." : "Quote berechnen"}
          </button>

          {error && (
            <div className="notice danger">
              <AlertTriangle size={16} />
              {error}
            </div>
          )}
        </form>

        <section className="panel result-panel">
          <div className="panel-title">
            <Gauge size={20} />
            <h2>Ergebnis</h2>
          </div>

          {!result ? (
            <div className="empty-state">Noch keine Quote berechnet.</div>
          ) : (
            <>
              <div className="metric-grid">
                <Metric label="Vote-Wert" value={`$${result.quote.expectedVoteUsd.toFixed(2)}`} />
                <Metric label="Vote-Gewicht" value={`${votePercent}%`} />
                <Metric label="Gebuehr" value={`$${result.feeInvoice.amountUsd.toFixed(2)}`} />
                <Metric label="Fee Vote" value={`${(result.feeInvoice.requiredVoteWeightBps / 100).toFixed(2)}%`} />
              </div>

              <div className="billing-strip">
                <span>Status</span>
                <strong>{statusLabel[result.account.status]}</strong>
              </div>

              <div className="fee-post">
                <span>Gebuehrenpost</span>
                <strong>@{result.feeInvoice.feePostAuthor}/{result.feeInvoice.feePostPermlink}</strong>
              </div>

              {result.quote.warnings.map((warning) => (
                <div className="notice" key={warning}>
                  <AlertTriangle size={16} />
                  {warning}
                </div>
              ))}
            </>
          )}
        </section>
      </section>
    </main>
  );
}

function ConsentPanel(props: {
  catalog: ConsentRecord[];
  consentError: string | null;
  loadingType: ConsentType | null;
  onGrant: (type: ConsentType) => void;
  onRevoke: (type: ConsentType) => void;
  session: AuthSession | null;
  state: ConsentState | null;
}) {
  const activeTypes = new Set(props.state?.active.map((record) => record.type) ?? []);
  const history = props.state?.history.slice(0, 4) ?? [];

  return (
    <section className="consent-panel">
      <div className="consent-head">
        <div>
          <span>Consent Layer</span>
          <strong>Login ist nicht gleich automatische Gebührenpost-Votes</strong>
        </div>
        <p>
          Jeder operative Schritt wird separat bestaetigt und kann widerrufen werden.
        </p>
      </div>

      {props.consentError && (
        <div className="notice danger compact-notice">
          <AlertTriangle size={16} />
          {props.consentError}
        </div>
      )}

      <div className="consent-grid">
        {props.catalog.map((record) => {
          const active = activeTypes.has(record.type);
          const disabled = !props.session || props.loadingType === record.type;
          return (
            <article className={`consent-card ${active ? "active" : ""}`} key={record.type}>
              <div className="consent-card-head">
                <span>{active ? "Aktiv" : "Ausstehend"}</span>
                <strong>{record.title}</strong>
              </div>
              <p>{record.description}</p>
              <ul>
                {record.scope.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
              {active ? (
                <button className="secondary-button consent-action" disabled={disabled} type="button" onClick={() => props.onRevoke(record.type)}>
                  Widerrufen
                </button>
              ) : (
                <button className="consent-action" disabled={disabled} type="button" onClick={() => props.onGrant(record.type)}>
                  Bestaetigen
                </button>
              )}
            </article>
          );
        })}
      </div>

      <div className="consent-history">
        <span>Consent-History</span>
        {history.length === 0 ? (
          <strong>Noch keine Consent-Aenderungen.</strong>
        ) : (
          history.map((record) => (
            <strong key={record.id}>
              {record.title}: {record.status === "granted" ? "bestaetigt" : "widerrufen"} am {new Date(record.revokedAt ?? record.createdAt ?? "").toLocaleDateString("de-DE")}
            </strong>
          ))
        )}
      </div>
    </section>
  );
}

function AuthBar(props: {
  authError: string | null;
  authLoading: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  session: AuthSession | null;
}) {
  return (
    <section className="auth-bar">
      <div>
        <span>SteemConnect</span>
        <strong>
          {props.session ? `@${props.session.user.username} verbunden` : "Non-custodial Login fuer Votes und Fee-Consent"}
        </strong>
      </div>
      {props.authError && (
        <div className="auth-error">
          <AlertTriangle size={15} />
          {props.authError}
        </div>
      )}
      {props.session ? (
        <button className="secondary-button" type="button" onClick={props.onDisconnect}>
          Signout
        </button>
      ) : (
        <button className="secondary-button" disabled={props.authLoading} type="button" onClick={props.onConnect}>
          <ShieldCheck size={16} />
          {props.authLoading ? "Verbinde..." : "Mit SteemConnect verbinden"}
        </button>
      )}
    </section>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function Dashboard() {
  const maxCurated = Math.max(...curationSeries.map((entry) => entry.curated));
  const trendPoints = curationSeries
    .map((entry, index) => {
      const x = (index / (curationSeries.length - 1)) * 100;
      const y = 100 - (entry.power / 100) * 86;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <section className="dashboard">
      <div className="summary-grid">
        <SummaryCard
          icon={<TrendingUp size={19} />}
          label="Total Curated Value"
          value={`$${dashboardStats.totalCuratedUsd.toFixed(2)}`}
          detail="Wert, der durch Votes bewegt wurde"
        />
        <SummaryCard
          icon={<WalletCards size={19} />}
          label="Active Vote Value"
          value={`$${dashboardStats.activeVoteUsd.toFixed(2)}`}
          detail="aktuell geplante Curation"
        />
        <SummaryCard
          icon={<ShieldCheck size={19} />}
          label="Fee Coverage"
          value={`${dashboardStats.feeCoverage}%`}
          detail={`$${(dashboardStats.feeUsd - dashboardStats.pendingFeesUsd).toFixed(2)} gedeckt`}
        />
        <SummaryCard
          icon={<BadgeDollarSign size={19} />}
          label="Pending Fees"
          value={`$${dashboardStats.pendingFeesUsd.toFixed(2)}`}
          detail={`$${dashboardStats.feeUsd.toFixed(2)} total bei 3%`}
        />
        <SummaryCard
          icon={<Gauge size={19} />}
          label="Voting Power Health"
          value={`${dashboardStats.votingPowerHealth}%`}
          detail="stark genug fuer Auto-Fee-Votes"
        />
        <SummaryCard
          icon={<LineChart size={19} />}
          label="Curation Efficiency"
          value={`${dashboardStats.curationEfficiency.toFixed(1)}x`}
          detail="$42.00 Nutzen zu $1.26 Gebuehr"
        />
      </div>

      <div className="analytics-grid">
        <section className="panel analytics-panel">
          <div className="panel-title compact-title">
            <BarChart3 size={20} />
            <h2>Curation Value vs. Fees</h2>
          </div>
          <div className="bar-chart" aria-label="Curation value compared with fee value">
            {curationSeries.map((entry) => (
              <div className="bar-column" key={entry.day}>
                <div className="bar-stack">
                  <span
                    className="bar curated"
                    style={{ height: `${Math.max(16, (entry.curated / maxCurated) * 100)}%` }}
                    title={`Curated $${entry.curated}`}
                  />
                  <span
                    className="bar fee"
                    style={{ height: `${Math.max(8, (entry.fees / maxCurated) * 100)}%` }}
                    title={`Fees $${entry.fees}`}
                  />
                </div>
                <strong>{entry.day}</strong>
              </div>
            ))}
          </div>
          <div className="chart-legend">
            <span><i className="legend curated" /> Curation</span>
            <span><i className="legend fee" /> Fee vote</span>
          </div>
        </section>

        <section className="panel analytics-panel">
          <div className="panel-title compact-title">
            <LineChart size={20} />
            <h2>Voting Power Verlauf</h2>
          </div>
          <div className="line-chart">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Voting power trend">
              <polyline points={trendPoints} />
            </svg>
            <div className="line-chart-overlay">
              <span>{dashboardStats.votingPowerHealth}%</span>
              <strong>Voting Power Health</strong>
            </div>
          </div>
          <div className="flow-list">
            {voteFlow.map((item) => (
              <div className="flow-row" key={item.label}>
                <span className={`flow-dot ${item.color}`} />
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="panel coverage-panel">
          <div>
            <div className="panel-title compact-title">
              <ShieldCheck size={20} />
              <h2>Fee Coverage</h2>
            </div>
            <p className="coverage-copy">
              Der Gebuehrenpost deckt fast alle offenen Rechnungen automatisch ab. Nur Accounts mit dauerhaft schwacher
              Voting Power landen in Warnung oder Pause.
            </p>
          </div>
          <div className="coverage-meter" style={{ "--coverage": `${dashboardStats.feeCoverage}%` } as React.CSSProperties}>
            <span>{dashboardStats.feeCoverage}%</span>
          </div>
        </section>
      </div>
    </section>
  );
}

function SummaryCard(props: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <section className="summary-card">
      <div className="summary-icon">{props.icon}</div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
    </section>
  );
}
