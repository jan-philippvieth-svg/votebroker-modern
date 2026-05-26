import type {
  TimingPerformanceBucket,
  VoteTimingOption,
  VoteTimingRecommendation,
  VoteTimingRequest,
  VotingAccountSnapshot
} from "./types.js";

export const voteDelayOptionsMinutes = [5, 10, 15, 20, 25, 30] as const;

export const defaultTimingPerformance: TimingPerformanceBucket[] = [
  { delayMinutes: 5, sampleSize: 42, curationEfficiencyPct: 83, authorRewardStabilityPct: 74, competitionPct: 68, reversalRiskPct: 18 },
  { delayMinutes: 10, sampleSize: 58, curationEfficiencyPct: 89, authorRewardStabilityPct: 82, competitionPct: 52, reversalRiskPct: 12 },
  { delayMinutes: 15, sampleSize: 64, curationEfficiencyPct: 92, authorRewardStabilityPct: 86, competitionPct: 44, reversalRiskPct: 10 },
  { delayMinutes: 20, sampleSize: 51, curationEfficiencyPct: 88, authorRewardStabilityPct: 91, competitionPct: 37, reversalRiskPct: 8 },
  { delayMinutes: 25, sampleSize: 36, curationEfficiencyPct: 82, authorRewardStabilityPct: 93, competitionPct: 30, reversalRiskPct: 7 },
  { delayMinutes: 30, sampleSize: 28, curationEfficiencyPct: 76, authorRewardStabilityPct: 94, competitionPct: 26, reversalRiskPct: 6 }
];

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function findBucket(delayMinutes: number, buckets: TimingPerformanceBucket[]): TimingPerformanceBucket {
  return buckets.find((bucket) => bucket.delayMinutes === delayMinutes)
    ?? buckets.reduce((nearest, bucket) => (
      Math.abs(bucket.delayMinutes - delayMinutes) < Math.abs(nearest.delayMinutes - delayMinutes)
        ? bucket
        : nearest
    ), buckets[0]);
}

function calculateOption(bucket: TimingPerformanceBucket, account: VotingAccountSnapshot): VoteTimingOption {
  const sampleConfidence = Math.min(100, (bucket.sampleSize / 60) * 100);
  const powerPenalty = account.votingPowerBps < 6_500 ? 8 : account.votingPowerBps > 8_500 ? -2 : 0;
  const riskPct = clampPct(bucket.reversalRiskPct + bucket.competitionPct * 0.18 + powerPenalty);
  const score = clampPct(
    bucket.curationEfficiencyPct * 0.42
    + bucket.authorRewardStabilityPct * 0.22
    + (100 - bucket.competitionPct) * 0.16
    + (100 - riskPct) * 0.12
    + sampleConfidence * 0.08
  );

  return {
    delayMinutes: bucket.delayMinutes,
    score,
    confidencePct: clampPct(sampleConfidence),
    expectedCurationPct: clampPct(bucket.curationEfficiencyPct),
    riskPct,
    label: `${bucket.delayMinutes} min nach Post-Erstellung`
  };
}

function calculateScheduledAt(request: VoteTimingRequest, delayMinutes: number): string | null {
  if (!request.postCreatedAt) {
    return null;
  }

  const createdAt = new Date(request.postCreatedAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return new Date(createdAt.getTime() + delayMinutes * 60_000).toISOString();
}

export function recommendVoteTiming(params: {
  account: VotingAccountSnapshot;
  request?: VoteTimingRequest;
  buckets?: TimingPerformanceBucket[];
}): VoteTimingRecommendation {
  const request = params.request ?? { mode: "auto" };
  const buckets = params.buckets ?? defaultTimingPerformance;
  const options = buckets
    .map((bucket) => calculateOption(bucket, params.account))
    .sort((left, right) => left.delayMinutes - right.delayMinutes);

  const selected = request.mode === "manual"
    ? calculateOption(findBucket(request.delayMinutes ?? 15, buckets), params.account)
    : [...options].sort((left, right) => right.score - left.score)[0];

  const rationale = request.mode === "manual"
    ? [
      `Manuell gewaehlt: ${selected.delayMinutes} Minuten nach Post-Erstellung.`,
      `Historischer Score fuer diesen Slot: ${selected.score}/100.`
    ]
    : [
      `${selected.delayMinutes} Minuten ist aktuell der staerkste Slot aus den Erfahrungsdaten.`,
      `Score ${selected.score}/100 bei ${selected.confidencePct}% Datenvertrauen und ${selected.riskPct}% Timing-Risiko.`
    ];

  if (params.account.votingPowerBps < 6_500) {
    rationale.push("Voting Power ist niedrig; Auto-Modus bleibt konservativer.");
  }

  return {
    mode: request.mode,
    selectedDelayMinutes: selected.delayMinutes,
    scheduledAt: calculateScheduledAt(request, selected.delayMinutes),
    confidencePct: selected.confidencePct,
    score: selected.score,
    rationale,
    options
  };
}
