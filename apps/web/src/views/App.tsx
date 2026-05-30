import {
  AlertTriangle,
  BadgeDollarSign,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Gauge,
  LineChart,
  Network,
  Send,
  ShieldCheck,
  TrendingUp,
  Users,
  WalletCards
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  completeSteemConnectLogin,
  getCommunityOverview,
  getConsentCatalog,
  getConsentState,
  getSteemConnectUrl,
  grantConsent,
  quoteVote,
  revokeConsent,
  signOut,
  type AuthSession,
  type CommunityPoolOverview,
  type ConsentRecord,
  type ConsentState,
  type ConsentType,
  type VoteQuoteResponse
} from "../api";
import { createTranslator, locales, type Locale } from "../i18n";

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

const timingDelayOptions = [5, 10, 15, 20, 25, 30];

export function App() {
  const [locale, setLocale] = useState<Locale>(() => (window.localStorage.getItem("votebroker.locale") as Locale | null) ?? "de");
  const [session, setSession] = useState<AuthSession | null>(() => {
    const raw = window.localStorage.getItem("votebroker.session");
    return raw ? JSON.parse(raw) as AuthSession : null;
  });
  const [username, setUsername] = useState("demo");
  const [author, setAuthor] = useState("authorname");
  const [permlink, setPermlink] = useState("example-post");
  const [desiredVoteUsd, setDesiredVoteUsd] = useState(2.5);
  const [timingMode, setTimingMode] = useState<"auto" | "manual">("auto");
  const [voteDelayMinutes, setVoteDelayMinutes] = useState(15);
  const [plannedVotesToday, setPlannedVotesToday] = useState(10);
  const [targetVotingPowerPct, setTargetVotingPowerPct] = useState(80);
  const [result, setResult] = useState<VoteQuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [consentCatalog, setConsentCatalog] = useState<ConsentRecord[]>([]);
  const [consentState, setConsentState] = useState<ConsentState | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [communityOverview, setCommunityOverview] = useState<CommunityPoolOverview | null>(null);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [consentLoading, setConsentLoading] = useState<ConsentType | null>(null);
  const t = createTranslator(locale);

  useEffect(() => {
    getConsentCatalog()
      .then(setConsentCatalog)
      .catch((err) => setConsentError(err instanceof Error ? err.message : "Consent catalog could not be loaded"));
  }, []);

  useEffect(() => {
    if (!session) {
      setConsentState(null);
      return;
    }

    getConsentState(session.token)
      .then(setConsentState)
      .catch((err) => setConsentError(err instanceof Error ? err.message : "Consent state could not be loaded"));
  }, [session]);

  useEffect(() => {
    getCommunityOverview(username)
      .then((overview) => {
        setCommunityOverview(overview);
        setCommunityError(null);
      })
      .catch((err) => setCommunityError(err instanceof Error ? err.message : "Community pool could not be loaded"));
  }, [username]);

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
      .catch((err) => setAuthError(err instanceof Error ? err.message : "Login failed"))
      .finally(() => setAuthLoading(false));
  }, []);

  const votePercent = useMemo(() => {
    if (!result) return "0.00";
    return (result.quote.voteWeightBps / 100).toFixed(2);
  }, [result]);

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    window.localStorage.setItem("votebroker.locale", nextLocale);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const quote = await quoteVote({
        username,
        author,
        permlink,
        desiredVoteUsd,
        timingMode,
        voteDelayMinutes: timingMode === "manual" ? voteDelayMinutes : undefined,
        plannedVotesToday,
        targetVotingPowerBps: targetVotingPowerPct * 100
      });
      setResult(quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
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
      setAuthError(err instanceof Error ? err.message : "Login could not be started");
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
      setConsentError("Please connect with SteemConnect first.");
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
      setConsentError(err instanceof Error ? err.message : "Consent could not be updated");
    } finally {
      setConsentLoading(null);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">VoteBroker</p>
          <h1>{t("dashboardTitle")}</h1>
        </div>
        <div className="topbar-actions">
          <label className="language-select">
            <span>{t("language")}</span>
            <select value={locale} onChange={(event) => changeLocale(event.target.value as Locale)}>
              {locales.map((item) => (
                <option key={item.code} value={item.code}>{item.label}</option>
              ))}
            </select>
          </label>
          <div className="status-pill">
            <CheckCircle2 size={16} />
            {t("feeBilling")}
          </div>

          <div className="power-recommendation-control">
            <div className="panel-title compact-title">
              <Gauge size={18} />
              <h2>Power-Stable Empfehlung</h2>
            </div>
            <div className="field-grid">
              <label>
                Geplante Votes heute
                <input
                  min="1"
                  max="200"
                  step="1"
                  type="number"
                  value={plannedVotesToday}
                  onChange={(event) => setPlannedVotesToday(Number(event.target.value))}
                />
              </label>
              <label>
                Ziel Voting Power morgen (%)
                <input
                  min="0"
                  max="100"
                  step="1"
                  type="number"
                  value={targetVotingPowerPct}
                  onChange={(event) => setTargetVotingPowerPct(Number(event.target.value))}
                />
              </label>
            </div>
            <p className="timing-hint">VoteBroker zeigt dir, wie stark einzelne Votes maximal sein sollten, damit deine Voting Power stabil bleibt.</p>
          </div>
        </div>
      </header>

      <AuthBar
        authError={authError}
        authLoading={authLoading}
        onConnect={connectSteem}
        onDisconnect={disconnect}
        session={session}
        t={t}
      />

      <ConsentPanel
        catalog={consentCatalog}
        consentError={consentError}
        loadingType={consentLoading}
        onGrant={(type) => updateConsent(type, "grant")}
        onRevoke={(type) => updateConsent(type, "revoke")}
        session={session}
        state={consentState}
        t={t}
      />

      <Dashboard communityError={communityError} overview={communityOverview} />

      <section className="workspace">
        <form className="panel vote-form" onSubmit={submit}>
          <div className="panel-title">
            <BadgeDollarSign size={20} />
            <h2>{t("createVote")}</h2>
          </div>

          <label>
            {t("account")}
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>

          <div className="field-grid">
            <label>
              {t("author")}
              <input value={author} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <label>
              {t("permlink")}
              <input value={permlink} onChange={(event) => setPermlink(event.target.value)} />
            </label>
          </div>

          <label>
            {t("targetUsd")}
            <input
              min="0.01"
              step="0.01"
              type="number"
              value={desiredVoteUsd}
              onChange={(event) => setDesiredVoteUsd(Number(event.target.value))}
            />
          </label>

          <div className="timing-control">
            <div className="panel-title compact-title">
              <Clock3 size={18} />
              <h2>Vote Timing</h2>
            </div>
            <div className="segmented-control">
              <button
                className={timingMode === "auto" ? "selected" : ""}
                type="button"
                onClick={() => setTimingMode("auto")}
              >
                Auto
              </button>
              <button
                className={timingMode === "manual" ? "selected" : ""}
                type="button"
                onClick={() => setTimingMode("manual")}
              >
                Manuell
              </button>
            </div>
            {timingMode === "manual" ? (
              <div className="delay-grid">
                {timingDelayOptions.map((minutes) => (
                  <button
                    className={voteDelayMinutes === minutes ? "selected" : ""}
                    key={minutes}
                    type="button"
                    onClick={() => setVoteDelayMinutes(minutes)}
                  >
                    {minutes} min
                  </button>
                ))}
              </div>
            ) : (
              <p className="timing-hint">Auto waehlt den Slot mit bestem Score aus Curation, Risiko, Konkurrenz und Datenvertrauen.</p>
            )}
          </div>

          <button disabled={loading} type="submit">
            <Send size={16} />
            {loading ? t("calculating") : t("calculateQuote")}
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
            <h2>{t("result")}</h2>
          </div>

          {!result ? (
            <div className="empty-state">{t("noQuote")}</div>
          ) : (
            <>
              <div className="metric-grid">
                <Metric label={t("voteValue")} value={`$${result.quote.expectedVoteUsd.toFixed(2)}`} />
                <Metric label={t("voteWeight")} value={`${votePercent}%`} />
                <Metric label={t("fee")} value={result.feeInvoice.amountUsd > 0 ? `$${result.feeInvoice.amountUsd.toFixed(2)}` : "Fair Use"} />
                <Metric label={t("feeVote")} value={`${(result.feeInvoice.requiredVoteWeightBps / 100).toFixed(2)}%`} />
              </div>

              <TimingResult timing={result.quote.timing} />
              <PowerRecommendationResult recommendation={result.quote.powerRecommendation} />
              <BillingTransparency invoice={result.feeInvoice} />

              <div className="billing-strip">
                <span>{t("status")}</span>
                <strong>{statusLabel[result.account.status]}</strong>
              </div>

              <div className="fee-post">
                <span>{t("feePost")}</span>
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

function PowerRecommendationResult(props: { recommendation: VoteQuoteResponse["quote"]["powerRecommendation"] }) {
  const recommendation = props.recommendation;
  const tone = recommendation.riskLevel === "low"
    ? "good"
    : recommendation.riskLevel === "medium"
      ? "watch"
      : "danger";

  return (
    <section className={`power-stable-result ${tone}`}>
      <div className="power-stable-head">
        <div>
          <span>Power-Stable Empfehlung</span>
          <strong>{recommendation.message}</strong>
        </div>
        <b>{recommendation.riskLevel}</b>
      </div>
      <p>{recommendation.detail}</p>
      <div className="power-stable-metrics">
        <Metric label="Empfohlen max." value={`${(recommendation.maxAverageVoteWeightBps / 100).toFixed(2)}%`} />
        <Metric label="Dieser Vote" value={`${(recommendation.desiredVoteWeightBps / 100).toFixed(2)}%`} />
        <Metric label="Tagesbudget" value={`${(recommendation.dailyPowerBudgetBps / 100).toFixed(2)}%`} />
        <Metric label="Ziel morgen" value={`${(recommendation.targetVotingPowerBps / 100).toFixed(0)}%`} />
      </div>
    </section>
  );
}

function BillingTransparency(props: { invoice: VoteQuoteResponse["feeInvoice"] }) {
  const modeTone = props.invoice.billingMode === "billable" || props.invoice.billingMode === "grace"
    ? "billable"
    : props.invoice.billingMode === "paused"
      ? "paused"
      : "free";

  return (
    <section className={`billing-transparency ${modeTone}`}>
      <div className="billing-transparency-head">
        <div>
          <span>Payment Rule</span>
          <strong>{props.invoice.transparency.headline}</strong>
        </div>
        <b>{props.invoice.billingMode}</b>
      </div>
      <p>{props.invoice.transparency.userMessage}</p>
      <small>{props.invoice.transparency.detail}</small>
      <ul>
        {props.invoice.transparency.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {props.invoice.transparency.donationAllowed && (
        <div className="donation-strip">
          Freiwilliger Support-Vote ist erlaubt, aber keine Pflicht.
        </div>
      )}
    </section>
  );
}

function TimingResult(props: { timing: VoteQuoteResponse["quote"]["timing"] }) {
  const bestOptions = [...props.timing.options].sort((left, right) => right.score - left.score).slice(0, 3);

  return (
    <section className="timing-result">
      <div className="timing-result-head">
        <div>
          <span>Vote Timing</span>
          <strong>{props.timing.selectedDelayMinutes} min nach Post-Erstellung</strong>
        </div>
        <div className="timing-score">
          <span>{props.timing.score}</span>
          Score
        </div>
      </div>
      <div className="timing-rationale">
        {props.timing.rationale.map((entry) => (
          <p key={entry}>{entry}</p>
        ))}
      </div>
      <div className="timing-options">
        {bestOptions.map((option) => (
          <div className={option.delayMinutes === props.timing.selectedDelayMinutes ? "selected" : ""} key={option.delayMinutes}>
            <strong>{option.delayMinutes} min</strong>
            <span>{option.score}/100</span>
            <small>{option.riskPct}% Risiko</small>
          </div>
        ))}
      </div>
    </section>
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
  t: ReturnType<typeof createTranslator>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const activeTypes = new Set(props.state?.active.map((record) => record.type) ?? []);
  const history = props.state?.history.slice(0, 4) ?? [];

  return (
    <section className="consent-panel">
      <div className="consent-head">
        <div>
          <span>{props.t("consentLayer")}</span>
          <strong>{props.t("consentHeadline")}</strong>
        </div>
        <p>{props.t("consentCopy")}</p>
        <div className="consent-manage">
          <button className="secondary-button manage-button" type="button" onClick={() => setMenuOpen((open) => !open)}>
            {props.t("manageConsent")}
            <ChevronDown size={16} />
          </button>
          {menuOpen && (
            <div className="consent-menu">
              <p>{props.t("manageConsentHint")}</p>
              {props.catalog.map((record) => {
                const active = activeTypes.has(record.type);
                return (
                  <div className="consent-menu-row" key={record.type}>
                    <div>
                      <strong>{record.title}</strong>
                      <span>{active ? props.t("active") : props.t("serviceBlocked")}</span>
                    </div>
                    <button
                      className="secondary-button revoke-button"
                      disabled={!active || !props.session || props.loadingType === record.type}
                      type="button"
                      onClick={() => props.onRevoke(record.type)}
                    >
                      {props.t("revoke")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
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
                <span>{active ? props.t("active") : props.t("pending")}</span>
                <strong>{record.title}</strong>
              </div>
              <p>{record.description}</p>
              <ul>
                {record.scope.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
              {!active && <div className="service-blocked">{props.t("serviceBlocked")}</div>}
              {active ? (
                <button className="secondary-button consent-action" disabled={disabled} type="button" onClick={() => props.onRevoke(record.type)}>
                  {props.t("revoke")}
                </button>
              ) : (
                <button className="consent-action" disabled={disabled} type="button" onClick={() => props.onGrant(record.type)}>
                  {props.t("confirm")}
                </button>
              )}
            </article>
          );
        })}
      </div>

      <div className="consent-history">
        <span>{props.t("consentHistory")}</span>
        {history.length === 0 ? (
          <strong>{props.t("noHistory")}</strong>
        ) : (
          history.map((record) => (
            <strong key={record.id}>
              {record.title}: {record.status === "granted" ? props.t("granted") : props.t("revoked")} {props.t("changedOn")} {new Date(record.revokedAt ?? record.createdAt ?? "").toLocaleDateString("de-DE")}
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
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <section className="auth-bar">
      <div>
        <span>{props.t("steemConnect")}</span>
        <strong>
          {props.session ? `@${props.session.user.username} ${props.t("connected")}` : props.t("nonCustodialLogin")}
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
          {props.t("signout")}
        </button>
      ) : (
        <button className="secondary-button" disabled={props.authLoading} type="button" onClick={props.onConnect}>
          <ShieldCheck size={16} />
          {props.authLoading ? props.t("connecting") : props.t("connect")}
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

function Dashboard(props: { communityError: string | null; overview: CommunityPoolOverview | null }) {
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

      <CommunityPoolSection communityError={props.communityError} overview={props.overview} />
    </section>
  );
}

function CommunityPoolSection(props: { communityError: string | null; overview: CommunityPoolOverview | null }) {
  if (props.communityError) {
    return (
      <section className="panel pool-panel">
        <div className="notice danger">
          <AlertTriangle size={16} />
          {props.communityError}
        </div>
      </section>
    );
  }

  const overview = props.overview;
  if (!overview) {
    return (
      <section className="panel pool-panel">
        <div className="empty-state">Community Pool wird geladen.</div>
      </section>
    );
  }

  const feeRatio = overview.pool.stats.feesUsd30d / overview.pool.stats.curatedUsd30d;
  const healthTone = overview.health.status === "excellent" || overview.health.status === "healthy"
    ? "good"
    : overview.health.status === "watch"
      ? "watch"
      : "blocked";

  return (
    <section className="pool-grid">
      <section className="panel pool-panel">
        <div className="panel-title compact-title">
          <Users size={20} />
          <h2>Community Pool</h2>
        </div>
        <div className="pool-headline">
          <div>
            <span>{overview.pool.name}</span>
            <strong>{overview.pool.stats.poolPowerSp.toLocaleString("de-DE")} SP</strong>
            <p>{overview.pool.description}</p>
          </div>
          <div className="pool-badge">
            {overview.pool.stats.activeMembers}/{overview.pool.members.length} aktiv
          </div>
        </div>

        <div className="pool-metrics">
          <Metric label="Curated 30d" value={`$${overview.pool.stats.curatedUsd30d.toFixed(2)}`} />
          <Metric label="Fees 30d" value={`$${overview.pool.stats.feesUsd30d.toFixed(2)}`} />
          <Metric label="Scheduled Votes" value={`$${overview.pool.stats.scheduledVotesUsd.toFixed(2)}`} />
          <Metric label="Fee Ratio" value={`${(feeRatio * 100).toFixed(1)}%`} />
        </div>

        <div className="policy-strip">
          <span>Pool-Regeln</span>
          <strong>Max ${overview.pool.policy.maxVoteUsdPerPost.toFixed(2)} pro Post</strong>
          <strong>{overview.pool.policy.dailyVoteBudgetUsd.toFixed(2)} USD Tagesbudget</strong>
          <strong>{(overview.pool.policy.minVotingPowerBps / 100).toFixed(0)}% min. Voting Power</strong>
        </div>

        <div className="member-list">
          {overview.pool.members.map((member) => (
            <div className="member-row" key={member.username}>
              <div>
                <strong>@{member.username}</strong>
                <span>{member.role} - {member.delegatedSp.toLocaleString("de-DE")} SP</span>
              </div>
              <span className={`member-status ${member.status}`}>{member.status}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel health-panel">
        <div className="panel-title compact-title">
          <Network size={20} />
          <h2>Account Health Score</h2>
        </div>
        <div className={`health-score ${healthTone}`}>
          <span>{overview.health.score}</span>
          <strong>{overview.health.status}</strong>
        </div>
        <p className="health-summary">{overview.health.summary}</p>

        <div className="factor-list">
          {overview.health.factors.map((factor) => (
            <div className="factor-row" key={factor.key}>
              <div>
                <strong>{factor.label}</strong>
                <span>{factor.detail}</span>
              </div>
              <div className="factor-meter" style={{ "--score": `${factor.score}%` } as React.CSSProperties}>
                <i />
              </div>
              <b>{factor.score}</b>
            </div>
          ))}
        </div>

        <div className="recommendations">
          <span>Naechste sinnvolle Schritte</span>
          {overview.health.recommendations.length === 0 ? (
            <strong>Alles stabil. Pool-Automation kann konservativ laufen.</strong>
          ) : (
            overview.health.recommendations.map((recommendation) => (
              <strong key={recommendation}>{recommendation}</strong>
            ))
          )}
        </div>
      </section>
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
