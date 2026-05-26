import type {
  AccountHealthScore,
  CommunityPoolMember,
  CommunityPoolOverview,
  CommunityPoolSnapshot,
  HealthScoreFactor,
  VotingAccountSnapshot
} from "./types.js";

const MAX_BPS = 10_000;

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function weightedScore(factors: HealthScoreFactor[]): number {
  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  if (totalWeight === 0) {
    return 0;
  }

  return clampScore(
    factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0) / totalWeight
  );
}

function statusFromScore(score: number): AccountHealthScore["status"] {
  if (score >= 86) return "excellent";
  if (score >= 72) return "healthy";
  if (score >= 45) return "watch";
  return "blocked";
}

function summaryFromStatus(status: AccountHealthScore["status"]): string {
  const summaries = {
    excellent: "Account ist stark genug fuer Pool-Automation und Fee-by-vote Billing.",
    healthy: "Account ist stabil, sollte aber Voting Power und offene Fees beobachten.",
    watch: "Account braucht Aufmerksamkeit, bevor Automationen aggressiver laufen.",
    blocked: "Account sollte keine automatisierten Pool-Votes ausfuehren, bis Consent oder Power repariert ist."
  };

  return summaries[status];
}

function recommendationsFromFactors(factors: HealthScoreFactor[]): string[] {
  return factors
    .filter((factor) => factor.score < 75)
    .sort((left, right) => left.score - right.score)
    .slice(0, 3)
    .map((factor) => {
      if (factor.key === "consent") return "Pool-, Vote- und Fee-Post-Consent vollstaendig bestaetigen.";
      if (factor.key === "fee_reliability") return "Offene Fees durch Fee-Post-Votes decken, bevor neue Pool-Votes geplant werden.";
      if (factor.key === "voting_power") return "Voting Power regenerieren lassen oder Tagesbudget reduzieren.";
      if (factor.key === "execution") return "Fehlgeschlagene Vote-Ausfuehrungen pruefen und Limits konservativer setzen.";
      return "Curation-Regeln pruefen und Pool-Aktivitaet stabilisieren.";
    });
}

export function calculateAccountHealthScore(params: {
  account: VotingAccountSnapshot;
  member: CommunityPoolMember;
  pendingFeesUsd: number;
}): AccountHealthScore {
  const consentScore = params.member.consentActive ? 100 : 0;
  const votingPowerScore = clampScore((params.account.votingPowerBps / MAX_BPS) * 100);
  const feeReliabilityScore = clampScore(params.member.feeReliabilityPct - params.pendingFeesUsd * 8);
  const executionScore = clampScore(params.member.executionReliabilityPct);
  const poolTrustScore = clampScore(
    params.member.status === "active" ? 94 : params.member.status === "limited" ? 62 : 28
  );

  const factors: HealthScoreFactor[] = [
    {
      key: "consent",
      label: "Consent Health",
      score: consentScore,
      weight: 0.25,
      detail: params.member.consentActive ? "Pool-Automation ist explizit erlaubt." : "Consent fehlt oder wurde widerrufen."
    },
    {
      key: "fee_reliability",
      label: "Fee Reliability",
      score: feeReliabilityScore,
      weight: 0.22,
      detail: `${params.pendingFeesUsd.toFixed(2)} USD offene Fees im Pool-Kontext.`
    },
    {
      key: "voting_power",
      label: "Voting Power Health",
      score: votingPowerScore,
      weight: 0.2,
      detail: `${(params.account.votingPowerBps / 100).toFixed(1)}% aktuelle Voting Power.`
    },
    {
      key: "execution",
      label: "Execution Reliability",
      score: executionScore,
      weight: 0.18,
      detail: `${params.member.executionReliabilityPct}% erfolgreiche geplante Vote-Ausfuehrungen.`
    },
    {
      key: "pool_trust",
      label: "Pool Trust",
      score: poolTrustScore,
      weight: 0.15,
      detail: `Mitgliedsstatus: ${params.member.status}.`
    }
  ];

  const score = weightedScore(factors);
  const status = statusFromScore(score);

  return {
    username: params.account.username,
    score,
    status,
    summary: summaryFromStatus(status),
    factors,
    recommendations: recommendationsFromFactors(factors)
  };
}

export function summarizeCommunityPool(params: {
  account: VotingAccountSnapshot;
  pool: CommunityPoolSnapshot;
  username: string;
}): CommunityPoolOverview {
  const member = params.pool.members.find((entry) => entry.username === params.username)
    ?? params.pool.members[0];

  return {
    pool: params.pool,
    health: calculateAccountHealthScore({
      account: params.account,
      member,
      pendingFeesUsd: params.pool.stats.pendingFeesUsd
    })
  };
}
