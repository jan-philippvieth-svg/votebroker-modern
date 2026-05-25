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
}

export interface VoteQuote {
  author: string;
  permlink: string;
  desiredVoteUsd: number;
  expectedVoteUsd: number;
  voteWeightBps: BasisPoints;
  capped: boolean;
  warnings: string[];
}

export interface FeePolicy {
  feeBps: BasisPoints;
  minFeeUsd: number;
  feePostAuthor: string;
  feePostPermlink: string;
  warningAfterFailures: number;
  pauseAfterFailures: number;
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
  status: "open" | "settled" | "underfunded";
  createdAt: string;
}

export interface BillingAssessment {
  invoice: FeeInvoice;
  accountStatus: AccountBillingStatus;
  settledUsd: number;
  missingUsd: number;
  warnings: string[];
}
