import { AlertTriangle, BarChart3, BadgeDollarSign, RefreshCcw, ShieldCheck, TrendingUp, Users } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { getOperatorOverview, type OperatorOverview } from "../api";

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function OperatorDashboard() {
  const [token, setToken] = useState(() => window.localStorage.getItem("votebroker.operatorToken") ?? "");
  const [overview, setOverview] = useState<OperatorOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(nextToken = token) {
    if (!nextToken) {
      setError("Operator-Token fehlt.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await getOperatorOverview(nextToken);
      setOverview(data);
      window.localStorage.setItem("votebroker.operatorToken", nextToken);
    } catch (err) {
      setOverview(null);
      setError(err instanceof Error ? err.message : "Operator Dashboard konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) {
      void load(token);
    }
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    void load();
  }

  return (
    <main className="shell operator-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">VoteBroker Internal</p>
          <h1>Operator Dashboard</h1>
        </div>
        <div className="status-pill">
          <ShieldCheck size={16} />
          Token protected
        </div>
      </header>

      <form className="operator-auth panel" onSubmit={submit}>
        <label>
          Operator Token
          <input
            autoComplete="off"
            placeholder="VOTEBROKER_OPERATOR_TOKEN"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <button disabled={loading} type="submit">
          <RefreshCcw size={16} />
          {loading ? "Lade Daten" : "Dashboard laden"}
        </button>
      </form>

      {error && (
        <div className="notice danger operator-notice">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {overview ? <OperatorOverviewPanel overview={overview} /> : <OperatorEmptyState />}
    </main>
  );
}

function OperatorEmptyState() {
  return (
    <section className="panel operator-empty">
      <strong>Keine Operator-Daten geladen.</strong>
      <p>Dieses Dashboard zeigt nur echte Runtime-Daten aus Invoices und Accounts. Ohne Token oder ohne erzeugte Invoices bleiben die Werte leer.</p>
    </section>
  );
}

function OperatorOverviewPanel(props: { overview: OperatorOverview }) {
  const overview = props.overview;

  return (
    <section className="operator-dashboard">
      <div className="summary-grid operator-summary-grid">
        <OperatorCard icon={<BadgeDollarSign size={19} />} label="Settled Fees" value={money(overview.revenue.settledFeeUsd)} detail="tatsaechlich gedeckte Fee-Post-Votes" />
        <OperatorCard icon={<TrendingUp size={19} />} label="Pending Fees" value={money(overview.revenue.pendingFeeUsd)} detail="offene Pflichtgebuehren" />
        <OperatorCard icon={<ShieldCheck size={19} />} label="Waived Fair Use" value={money(overview.revenue.waivedFeeUsd)} detail="bewusst erlassene faire Gebuehren" />
        <OperatorCard icon={<BadgeDollarSign size={19} />} label="Donation Potential" value={money(overview.revenue.donationOpportunityUsd)} detail="freiwilliger Support, noch nicht als Einnahme" />
        <OperatorCard icon={<BarChart3 size={19} />} label="Curation Moved" value={money(overview.revenue.curationMovedUsd)} detail="aus echten Quote-Invoices aggregiert" />
        <OperatorCard icon={<Users size={19} />} label="Active Accounts" value={`${overview.accounts.active}/${overview.accounts.total}`} detail="Runtime-Accounts im Service" />
      </div>

      <div className="operator-grid">
        <section className="panel">
          <div className="panel-title compact-title">
            <BarChart3 size={20} />
            <h2>Revenue State</h2>
          </div>
          <div className="operator-bars">
            <OperatorBar label="Settled" value={overview.revenue.settledFeeUsd} max={Math.max(1, overview.revenue.curationMovedUsd)} />
            <OperatorBar label="Pending" value={overview.revenue.pendingFeeUsd} max={Math.max(1, overview.revenue.curationMovedUsd)} />
            <OperatorBar label="Underfunded" value={overview.revenue.underfundedFeeUsd} max={Math.max(1, overview.revenue.curationMovedUsd)} />
            <OperatorBar label="Waived" value={overview.revenue.waivedFeeUsd} max={Math.max(1, overview.revenue.curationMovedUsd)} />
          </div>
          <div className="operator-coverage">
            <span>Fee Coverage</span>
            <strong>{overview.revenue.feeCoveragePct}%</strong>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title compact-title">
            <ShieldCheck size={20} />
            <h2>Billing Modes</h2>
          </div>
          <div className="operator-mode-grid">
            {Object.entries(overview.billingModes).map(([mode, count]) => (
              <div key={mode}>
                <span>{mode}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          <div className="operator-mode-grid invoice-state-grid">
            <div><span>open</span><strong>{overview.invoices.open}</strong></div>
            <div><span>settled</span><strong>{overview.invoices.settled}</strong></div>
            <div><span>waived</span><strong>{overview.invoices.waived}</strong></div>
            <div><span>donation</span><strong>{overview.invoices.donationOptional}</strong></div>
          </div>
        </section>
      </div>

      <div className="operator-grid">
        <section className="panel">
          <div className="panel-title compact-title">
            <Users size={20} />
            <h2>Top Accounts</h2>
          </div>
          {overview.topAccounts.length === 0 ? (
            <div className="operator-table-empty">Noch keine Account-Revenue-Daten.</div>
          ) : (
            <div className="operator-table">
              {overview.topAccounts.map((account) => (
                <div className="operator-table-row" key={account.username}>
                  <strong>@{account.username}</strong>
                  <span>{money(account.settledFeeUsd)} settled</span>
                  <span>{money(account.pendingFeeUsd)} pending</span>
                  <span>{account.invoiceCount} invoices</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-title compact-title">
            <BadgeDollarSign size={20} />
            <h2>Recent Invoices</h2>
          </div>
          {overview.recentInvoices.length === 0 ? (
            <div className="operator-table-empty">Noch keine echten Invoices erzeugt.</div>
          ) : (
            <div className="operator-table">
              {overview.recentInvoices.map((invoice) => (
                <div className="operator-table-row" key={invoice.id}>
                  <strong>{invoice.billingMode}</strong>
                  <span>@{invoice.username}</span>
                  <span>{money(invoice.amountUsd)} fee</span>
                  <span>{invoice.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function OperatorCard(props: { detail: string; icon: React.ReactNode; label: string; value: string }) {
  return (
    <section className="summary-card">
      <div className="summary-icon">{props.icon}</div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
    </section>
  );
}

function OperatorBar(props: { label: string; max: number; value: number }) {
  const width = Math.max(2, Math.min(100, (props.value / props.max) * 100));

  return (
    <div className="operator-bar-row">
      <span>{props.label}</span>
      <div><i style={{ width: `${width}%` }} /></div>
      <strong>{money(props.value)}</strong>
    </div>
  );
}
