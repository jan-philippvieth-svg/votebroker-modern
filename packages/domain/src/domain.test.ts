import assert from "node:assert/strict";
import test from "node:test";
import { assessFeeVote, createFeeInvoice, quoteUsdVote } from "./index.js";
import type { FeePolicy, VotingAccountSnapshot } from "./index.js";

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
  pauseAfterFailures: 4
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
