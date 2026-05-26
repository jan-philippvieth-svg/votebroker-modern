import type { CommunityPoolSnapshot, FeeInvoice, VotingAccountSnapshot } from "@votebroker/domain";

export const accounts = new Map<string, VotingAccountSnapshot>([
  [
    "demo",
    {
      username: "demo",
      votingPowerBps: 8_000,
      fullPowerVoteUsd: 10,
      status: "active",
      consecutiveUnderfundedFees: 0
    }
  ]
]);

export const invoices = new Map<string, FeeInvoice>();

export const communityPools = new Map<string, CommunityPoolSnapshot>([
  [
    "steem-curators",
    {
      id: "pool_steem_curators",
      name: "Steem Curators Pool",
      slug: "steem-curators",
      description: "Gemeinsame Curation fuer aktive Steem-Autoren mit transparenter Fee-by-vote Abrechnung.",
      policy: {
        maxVoteUsdPerPost: 3.5,
        dailyVoteBudgetUsd: 24,
        minVotingPowerBps: 6_500,
        feeBps: 300,
        requireFeePostConsent: true,
        requirePoolConsent: true,
        allowedTags: ["steem", "deutsch", "curation", "community"],
        blockedAuthors: ["known-spam-account"]
      },
      members: [
        {
          username: "demo",
          role: "admin",
          delegatedSp: 7200,
          votingPowerBps: 8_000,
          consentActive: true,
          feeReliabilityPct: 96,
          executionReliabilityPct: 98,
          status: "active"
        },
        {
          username: "curator-one",
          role: "curator",
          delegatedSp: 4300,
          votingPowerBps: 7_300,
          consentActive: true,
          feeReliabilityPct: 91,
          executionReliabilityPct: 94,
          status: "active"
        },
        {
          username: "community-member",
          role: "member",
          delegatedSp: 1250,
          votingPowerBps: 5_900,
          consentActive: false,
          feeReliabilityPct: 72,
          executionReliabilityPct: 84,
          status: "limited"
        }
      ],
      stats: {
        poolPowerSp: 12_750,
        activeMembers: 2,
        curatedUsd30d: 318.4,
        feesUsd30d: 9.55,
        pendingFeesUsd: 0.42,
        scheduledVotesUsd: 38.6,
        executionRatePct: 96,
        fairnessPct: 89
      }
    }
  ]
]);

export function getAccount(username: string): VotingAccountSnapshot {
  const account = accounts.get(username);
  if (!account) {
    return {
      username,
      votingPowerBps: 0,
      fullPowerVoteUsd: 0,
      status: "warning",
      consecutiveUnderfundedFees: 0
    };
  }
  return account;
}

export function saveAccount(account: VotingAccountSnapshot): void {
  accounts.set(account.username, account);
}

export function getCommunityPool(slug = "steem-curators"): CommunityPoolSnapshot {
  const pool = communityPools.get(slug);
  if (!pool) {
    throw new Error(`Community pool not found: ${slug}`);
  }

  return pool;
}
