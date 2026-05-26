export type BasisPoints = number;

export type AccountBillingStatus =
  | "active"
  | "warning"
  | "paused"
  | "payment_required";

export interface VotingAccountSnapshot {
  username: string;
  votingPowerBps: BasisPoints;
  fullPowerVoteUsd: number;
  status: AccountBillingStatus;
  consecutiveUnderfundedFees: number;
}

export interface VoteQuoteRequest {
  author: string;
  permlink: string;
  desiredVoteUsd: number;
  account: VotingAccountSnapshot;
  timing?: VoteTimingRequest;
}

export interface VoteQuote {
  author: string;
  permlink: string;
  desiredVoteUsd: number;
  expectedVoteUsd: number;
  voteWeightBps: BasisPoints;
  capped: boolean;
  warnings: string[];
  timing: VoteTimingRecommendation;
}

export type VoteTimingMode = "manual" | "auto";

export interface VoteTimingRequest {
  mode: VoteTimingMode;
  delayMinutes?: number;
  postCreatedAt?: string;
}

export interface TimingPerformanceBucket {
  delayMinutes: number;
  sampleSize: number;
  curationEfficiencyPct: number;
  authorRewardStabilityPct: number;
  competitionPct: number;
  reversalRiskPct: number;
}

export interface VoteTimingOption {
  delayMinutes: number;
  score: number;
  confidencePct: number;
  expectedCurationPct: number;
  riskPct: number;
  label: string;
}

export interface VoteTimingRecommendation {
  mode: VoteTimingMode;
  selectedDelayMinutes: number;
  scheduledAt: string | null;
  confidencePct: number;
  score: number;
  rationale: string[];
  options: VoteTimingOption[];
}

export interface FeePolicy {
  feeBps: BasisPoints;
  minFeeUsd: number;
  feePostAuthor: string;
  feePostPermlink: string;
  warningAfterFailures: number;
  pauseAfterFailures: number;
  freeUntilVoteUsd: number;
  donationUntilVoteUsd: number;
  maxFeeVoteWeightBps: BasisPoints;
  graceConsecutiveFailures: number;
}

export interface FeeInvoice {
  id: string;
  username: string;
  sourceAuthor: string;
  sourcePermlink: string;
  amountUsd: number;
  feePostAuthor: string;
  feePostPermlink: string;
  requiredVoteWeightBps: BasisPoints;
  status: "open" | "settled" | "underfunded" | "waived" | "donation_optional";
  billingMode: BillingMode;
  transparency: BillingTransparency;
  createdAt: string;
}

export type BillingMode = "free" | "donation" | "billable" | "grace" | "paused";

export interface BillingTransparency {
  headline: string;
  detail: string;
  userMessage: string;
  donationAllowed: boolean;
  feeRequired: boolean;
  reasons: string[];
}

export interface BillingAssessment {
  invoice: FeeInvoice;
  accountStatus: AccountBillingStatus;
  settledUsd: number;
  missingUsd: number;
  warnings: string[];
}

export type PoolRole = "owner" | "admin" | "curator" | "member";

export type PoolMembershipStatus = "active" | "limited" | "paused";

export interface CommunityPoolPolicy {
  maxVoteUsdPerPost: number;
  dailyVoteBudgetUsd: number;
  minVotingPowerBps: BasisPoints;
  feeBps: BasisPoints;
  requireFeePostConsent: boolean;
  requirePoolConsent: boolean;
  allowedTags: string[];
  blockedAuthors: string[];
}

export interface CommunityPoolMember {
  username: string;
  role: PoolRole;
  delegatedSp: number;
  votingPowerBps: BasisPoints;
  consentActive: boolean;
  feeReliabilityPct: number;
  executionReliabilityPct: number;
  status: PoolMembershipStatus;
}

export interface CommunityPoolSnapshot {
  id: string;
  name: string;
  slug: string;
  description: string;
  members: CommunityPoolMember[];
  policy: CommunityPoolPolicy;
  stats: {
    poolPowerSp: number;
    activeMembers: number;
    curatedUsd30d: number;
    feesUsd30d: number;
    pendingFeesUsd: number;
    scheduledVotesUsd: number;
    executionRatePct: number;
    fairnessPct: number;
  };
}

export interface HealthScoreFactor {
  key: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export interface AccountHealthScore {
  username: string;
  score: number;
  status: "excellent" | "healthy" | "watch" | "blocked";
  summary: string;
  factors: HealthScoreFactor[];
  recommendations: string[];
}

export interface CommunityPoolOverview {
  pool: CommunityPoolSnapshot;
  health: AccountHealthScore;
}
