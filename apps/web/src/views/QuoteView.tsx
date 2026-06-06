// ── QuoteView — VoteExecutionPanel und Helpers ───────────────────────────────
// Extracted from App.tsx — vote quote display and execution panel

import React from "react";
import { Send } from "lucide-react";
import { createTranslator } from "../i18n";
import type { VoteQuoteResponse, VoteExecutionResponse } from "../api";

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

export function VoteExecutionPanel(props: {
  quote: VoteQuoteResponse;
  execution: VoteExecutionResponse | null;
  error: { message: string; code: string; hint?: string } | null;
  hasSession: boolean;
  onExecute: () => void;
  locale?: import("../i18n").Locale;
}) {
  const t = createTranslator(props.locale ?? "de");
  const errorActionLink: Record<string, { label: string; tab: string }> = {
    target_vote_consent_required: { label: t("consentOpenSettings"), tab: "billing" },
    missing_posting_authority:    { label: t("consentGrantAuthority"), tab: "billing" },
  };

  return (
    <section className="execution-panel">
      <div>
        <span>Live Vote Broadcast</span>
        <strong>{props.hasSession ? t("consentReadyRequired") : t("consentLoginRequired")}</strong>
        <p>VoteBroker sendet diesen Vote erst nach aktivem Vote-Consent. Der Posting-Key verlässt niemals den Server.</p>
      </div>
      <button className="primary-button" disabled={!props.hasSession || props.quote.quote.voteWeightBps <= 0} type="button" onClick={props.onExecute}>
        <Send size={16} />
        Vote senden
      </button>
      {props.execution && (
        <p className="execution-success">✓ Broadcast akzeptiert · TX: {props.execution.transactionId}</p>
      )}
      {props.error && (
        <div style={{ marginTop: "0.5rem" }}>
          <p className="execution-error" style={{ margin: 0 }}>
            ✗ {props.error.message}
          </p>
          {props.error.hint && (
            <p style={{ color: "#607078", fontSize: "0.78rem", margin: "0.2rem 0 0" }}>
              → {props.error.hint}
            </p>
          )}
          {errorActionLink[props.error.code] && (
            <p style={{ color: "#2563eb", fontSize: "0.78rem", margin: "0.2rem 0 0" }}>
              {t("hintGoToSettings")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function PowerRecommendationResult(props: { recommendation: VoteQuoteResponse["quote"]["powerRecommendation"] }) {
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

export function BillingTransparency(props: { invoice: VoteQuoteResponse["feeInvoice"] }) {
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

export function TimingResult(props: { timing: VoteQuoteResponse["quote"]["timing"] }) {
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
