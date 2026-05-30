import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateVoteBroadcastPolicy,
  hasPostingAuthority,
  requireBroadcastConfig
} from "./steemBroadcaster.js";

const posting = {
  weight_threshold: 1,
  account_auths: [["votebroker", 1] as [string, number]],
  key_auths: []
};

test("rejects server-side broadcast without posting WIF", () => {
  assert.throws(() => requireBroadcastConfig({
    account: "votebroker",
    postingWif: ""
  }), /VOTEBROKER_POSTING_WIF/);
});

test("detects missing VoteBroker posting authority", () => {
  assert.equal(hasPostingAuthority({
    posting: {
      ...posting,
      account_auths: [["someone-else", 1]]
    }
  } as never, "votebroker"), false);
});

test("blocks vote without consent", () => {
  const result = evaluateVoteBroadcastPolicy({
    hasConsent: false,
    hasPostingAuthority: true,
    hasPostingWif: true,
    accountStatus: "active",
    fullPowerVoteUsd: 10,
    weightBps: 500
  });

  assert.deepEqual(result, {
    allowed: false,
    reason: "missing_consent"
  });
});

test("blocks vote when account is paused", () => {
  const result = evaluateVoteBroadcastPolicy({
    hasConsent: true,
    hasPostingAuthority: true,
    hasPostingWif: true,
    accountStatus: "paused",
    fullPowerVoteUsd: 10,
    weightBps: 500
  });

  assert.deepEqual(result, {
    allowed: false,
    reason: "account_paused"
  });
});

test("blocks vote when quote is implausible", () => {
  const result = evaluateVoteBroadcastPolicy({
    hasConsent: true,
    hasPostingAuthority: true,
    hasPostingWif: true,
    accountStatus: "active",
    fullPowerVoteUsd: 0,
    weightBps: 500
  });

  assert.deepEqual(result, {
    allowed: false,
    reason: "implausible_quote"
  });
});

test("blocks vote with invalid weight", () => {
  const result = evaluateVoteBroadcastPolicy({
    hasConsent: true,
    hasPostingAuthority: true,
    hasPostingWif: true,
    accountStatus: "active",
    fullPowerVoteUsd: 10,
    weightBps: 10_001
  });

  assert.deepEqual(result, {
    allowed: false,
    reason: "invalid_weight"
  });
});

test("allows vote with consent, posting authority, WIF, and plausible quote", () => {
  const result = evaluateVoteBroadcastPolicy({
    hasConsent: true,
    hasPostingAuthority: true,
    hasPostingWif: true,
    accountStatus: "active",
    fullPowerVoteUsd: 10,
    weightBps: 500
  });

  assert.deepEqual(result, {
    allowed: true
  });
});
