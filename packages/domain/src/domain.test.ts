import assert from "node:assert/strict";
import test from "node:test";
import { assessFeeVote, calculateAccountHealthScore, createFeeInvoice, createOperatorOverview, quoteUsdVote, recommendVoteTiming } from "./index.js";
import type { CommunityPoolMember, FeePolicy, VotingAccountSnapshot } from "./index.js";

const account: VotingAccountSnapshot = {
  username: "alice",
  votingPowerBps: 8_000,
  fullPowerVoteUsd: 10,
  status: "active",
  consecutiveUnderfundedFees: 0
};

const policy: FeePolicy = {
  feeBps: 300,
  minFeeUsd: 0.05,
  feePostAuthor: "votebroker",
  feePostPermlink: "fees-2026-05",
  warningAfterFailures: 2,
  pauseAfterFailures: 4,
  freeUntilVoteUsd: 0.25,
  donationUntilVoteUsd: 1,
  maxFeeVoteWeightBps: 2_000,
  graceConsecutiveFailures: 2
};

test("quotes a vote by desired USD amount", () => {
  const quote = quoteUsdVote({
    author: "bob",
    permlink: "post",
    desiredVoteUsd: 4,
    account
  });

  assert.equal(quote.voteWeightBps, 5_000);
  assert.equal(quote.expectedVoteUsd, 4);
  assert.equal(quote.capped, false);
});

test("creates fee invoice from expected vote value", () => {
  const quote = quoteUsdVote({
    author: "bob",
    permlink: "post",
    desiredVoteUsd: 4,
    account
  });
  const invoice = createFeeInvoice({ id: "fee_1", account, quote, policy });

  assert.equal(invoice.amountUsd, 0.12);
  assert.equal(invoice.feePostAuthor, "votebroker");
  assert.equal(invoice.requiredVoteWeightBps, 150);
  assert.equal(invoice.billingMode, "billable");
});

test("pauses account after repeated underfunded fee votes", () => {
  const weakAccount = {
    ...account,
    votingPowerBps: 100,
    consecutiveUnderfundedFees: 3
  };
  const quote = quoteUsdVote({
    author: "bob",
    permlink: "post",
    desiredVoteUsd: 4,
    account
  });
  const invoice = createFeeInvoice({ id: "fee_2", account, quote, policy });
  const assessment = assessFeeVote({ account: weakAccount, invoice, policy });

  assert.equal(assessment.invoice.status, "underfunded");
  assert.equal(assessment.accountStatus, "paused");
});

test("calculates explainable account health score for pool automation", () => {
  const member: CommunityPoolMember = {
    username: "alice",
    role: "curator",
    delegatedSp: 7200,
    votingPowerBps: 8_000,
    consentActive: true,
    feeReliabilityPct: 96,
    executionReliabilityPct: 98,
    status: "active"
  };

  const health = calculateAccountHealthScore({
    account,
    member,
    pendingFeesUsd: 0.08
  });

  assert.equal(health.status, "excellent");
  assert.equal(health.factors.length, 5);
  assert.ok(health.score >= 86);
});

test("blocks health score when pool consent is missing", () => {
  const member: CommunityPoolMember = {
    username: "alice",
    role: "curator",
    delegatedSp: 7200,
    votingPowerBps: 8_000,
    consentActive: false,
    feeReliabilityPct: 82,
    executionReliabilityPct: 88,
    status: "paused"
  };

  const health = calculateAccountHealthScore({
    account,
    member,
    pendingFeesUsd: 2
  });

  assert.equal(health.status, "watch");
  assert.ok(health.recommendations.includes("Pool-, Vote- und Fee-Post-Consent vollstaendig bestaetigen."));
});

test("recommends an automatic vote timing slot from observed buckets", () => {
  const timing = recommendVoteTiming({ account });

  assert.equal(timing.mode, "auto");
  assert.equal(timing.selectedDelayMinutes, 15);
  assert.ok(timing.score >= 80);
  assert.equal(timing.options.length, 6);
});

test("keeps manual vote timing when user selects a delay", () => {
  const quote = quoteUsdVote({
    author: "bob",
    permlink: "timed-post",
    desiredVoteUsd: 4,
    account,
    timing: {
      mode: "manual",
      delayMinutes: 20,
      postCreatedAt: "2026-05-26T10:00:00.000Z"
    }
  });

  assert.equal(quote.timing.mode, "manual");
  assert.equal(quote.timing.selectedDelayMinutes, 20);
  assert.equal(quote.timing.scheduledAt, "2026-05-26T10:20:00.000Z");
});

test("waives mandatory fees for very small fair-use votes", () => {
  const quote = quoteUsdVote({
    author: "bob",
    permlink: "small-post",
    desiredVoteUsd: 0.2,
    account
  });
  const invoice = createFeeInvoice({ id: "fee_free", account, quote, policy });

  assert.equal(invoice.billingMode, "free");
  assert.equal(invoice.status, "waived");
  assert.equal(invoice.amountUsd, 0);
  assert.equal(invoice.transparency.feeRequired, false);
});

test("offers donation mode when mandatory billing would be unfair", () => {
  const tinyAccount = {
    ...account,
    votingPowerBps: 500,
    fullPowerVoteUsd: 10
  };
  const quote = quoteUsdVote({
    author: "bob",
    permlink: "starter-post",
    desiredVoteUsd: 0.8,
    account: tinyAccount
  });
  const invoice = createFeeInvoice({ id: "fee_donation", account: tinyAccount, quote, policy });

  assert.equal(invoice.billingMode, "donation");
  assert.equal(invoice.status, "donation_optional");
  assert.equal(invoice.transparency.donationAllowed, true);
});

test("aggregates operator overview from actual invoices", () => {
  const quote = quoteUsdVote({
    author: "bob",
    permlink: "operator-post",
    desiredVoteUsd: 4,
    account
  });
  const openInvoice = createFeeInvoice({ id: "fee_open", account, quote, policy });
  const settledInvoice = { ...openInvoice, id: "fee_settled", status: "settled" as const };
  const freeQuote = quoteUsdVote({
    author: "bob",
    permlink: "free-post",
    desiredVoteUsd: 0.2,
    account
  });
  const waivedInvoice = createFeeInvoice({ id: "fee_waived", account, quote: freeQuote, policy });

  const overview = createOperatorOverview({
    accounts: [account],
    invoices: [openInvoice, settledInvoice, waivedInvoice],
    now: new Date("2026-05-26T12:00:00.000Z")
  });

  assert.equal(overview.invoices.total, 3);
  assert.equal(overview.revenue.pendingFeeUsd, 0.12);
  assert.equal(overview.revenue.settledFeeUsd, 0.12);
  assert.equal(overview.revenue.waivedFeeUsd, 0.05);
  assert.equal(overview.topAccounts[0].username, "alice");
});
