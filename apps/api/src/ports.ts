import type { FeeInvoice, VoteQuote, VotingAccountSnapshot } from "@votebroker/domain";
import type { VoteTimingMode } from "@votebroker/domain";

export interface AccountPowerProvider {
  getAccountSnapshot(username: string): Promise<VotingAccountSnapshot>;
}

export interface VoteBroadcaster {
  vote(params: {
    voter: string;
    author: string;
    permlink: string;
    weightBps: number;
    reason: "post_vote" | "fee_vote";
  }): Promise<{ transactionId: string; estimatedUsd: number }>;
}

export interface InvoiceRepository {
  create(invoice: FeeInvoice): Promise<void>;
  findById(id: string): Promise<FeeInvoice | undefined>;
  save(invoice: FeeInvoice): Promise<void>;
}

export interface ConsentRepository {
  hasFeeVoteConsent(username: string): Promise<boolean>;
}

export interface VoteBrokerWorkflow {
  quotePostVote(params: {
    username: string;
    author: string;
    permlink: string;
    desiredVoteUsd: number;
    timingMode?: VoteTimingMode;
    voteDelayMinutes?: number;
    postCreatedAt?: string;
  }): Promise<{ account: VotingAccountSnapshot; quote: VoteQuote; invoice: FeeInvoice }>;
}
