import type { PowerStableRecommendation, PowerStableRecommendationRequest, VotingAccountSnapshot } from "./types.js";
import { MAX_BPS, clampBps } from "./voteMath.js";

const DEFAULT_TARGET_BPS = 8_000;
const DEFAULT_PLANNED_VOTES = 10;
const DEFAULT_HOURS_UNTIL_TOMORROW = 24;
const DEFAULT_SAFETY_RESERVE_BPS = 300;
const DAILY_REGEN_BPS = 2_000;

function riskFor(desiredVoteWeightBps: number, maxAverageVoteWeightBps: number, dailyPowerBudgetBps: number): PowerStableRecommendation["riskLevel"] {
  if (dailyPowerBudgetBps <= 0) return "recovery";
  if (desiredVoteWeightBps <= maxAverageVoteWeightBps) return "low";
  if (desiredVoteWeightBps <= maxAverageVoteWeightBps * 1.5) return "medium";
  return "high";
}

export function recommendPowerStableVote(params: {
  account: VotingAccountSnapshot;
  desiredVoteWeightBps: number;
  request?: PowerStableRecommendationRequest;
}): PowerStableRecommendation {
  const plannedVotesToday = Math.max(1, Math.round(params.request?.plannedVotesToday ?? DEFAULT_PLANNED_VOTES));
  const targetVotingPowerBps = clampBps(params.request?.targetVotingPowerBps ?? DEFAULT_TARGET_BPS);
  const hoursUntilTomorrow = Math.max(0, Math.min(24, params.request?.hoursUntilTomorrow ?? DEFAULT_HOURS_UNTIL_TOMORROW));
  const safetyReserveBps = clampBps(params.request?.safetyReserveBps ?? DEFAULT_SAFETY_RESERVE_BPS);
  const estimatedRegenerationBps = clampBps((hoursUntilTomorrow / 24) * DAILY_REGEN_BPS);
  const dailyPowerBudgetBps = clampBps(
    params.account.votingPowerBps + estimatedRegenerationBps - targetVotingPowerBps - safetyReserveBps
  );
  const maxAverageVoteWeightBps = dailyPowerBudgetBps <= 0
    ? 0
    : clampBps(dailyPowerBudgetBps / plannedVotesToday);
  const desiredVoteWeightBps = clampBps(params.desiredVoteWeightBps);
  const riskLevel = riskFor(desiredVoteWeightBps, maxAverageVoteWeightBps, dailyPowerBudgetBps);
  const withinRecommendation = riskLevel === "low";

  if (riskLevel === "recovery") {
    return {
      plannedVotesToday,
      targetVotingPowerBps,
      estimatedRegenerationBps,
      dailyPowerBudgetBps,
      maxAverageVoteWeightBps,
      desiredVoteWeightBps,
      riskLevel,
      withinRecommendation,
      message: "Recovery Mode: Heute besser sehr sparsam voten.",
      detail: `Bei ${plannedVotesToday} geplanten Votes bleibt kein stabiler Tagespuffer, wenn morgen ${(targetVotingPowerBps / 100).toFixed(0)}% Voting Power erreicht werden soll.`
    };
  }

  return {
    plannedVotesToday,
    targetVotingPowerBps,
    estimatedRegenerationBps,
    dailyPowerBudgetBps,
    maxAverageVoteWeightBps,
    desiredVoteWeightBps,
    riskLevel,
    withinRecommendation,
    message: withinRecommendation
      ? "Dieser Vote liegt im power-stabilen Tagesbudget."
      : "Dieser Vote liegt ueber der power-stabilen Empfehlung.",
    detail: `Bei ${plannedVotesToday} geplanten Votes sollte jeder Vote im Schnitt maximal ${(maxAverageVoteWeightBps / 100).toFixed(2)}% Gewicht nutzen, damit deine Voting Power morgen voraussichtlich bei ${(targetVotingPowerBps / 100).toFixed(0)}% liegt.`
  };
}
