import { MAX_BPS, clampBps, getAvailableFullVoteUsd, roundUsd } from "./voteMath.js";
import type {
  AccountBillingStatus,
  BillingAssessment,
  FeeInvoice,
  FeePolicy,
  VoteQuote,
  VotingAccountSnapshot
} from "./types.js";

export function createFeeInvoice(params: {
  id: string;
  account: VotingAccountSnapshot;
  quote: VoteQuote;
  policy: FeePolicy;
  createdAt?: Date;
}): FeeInvoice {
  const amountUsd = Math.max(
    params.policy.minFeeUsd,
    params.quote.expectedVoteUsd * (params.policy.feeBps / MAX_BPS)
  );
  const availableFullVoteUsd = getAvailableFullVoteUsd(
    params.account.fullPowerVoteUsd,
    params.account.votingPowerBps
  );
  const requiredVoteWeightBps =
    availableFullVoteUsd <= 0 ? MAX_BPS : clampBps((amountUsd / availableFullVoteUsd) * MAX_BPS);

  return {
    id: params.id,
    username: params.account.username,
    sourceAuthor: params.quote.author,
    sourcePermlink: params.quote.permlink,
    amountUsd: roundUsd(amountUsd),
    feePostAuthor: params.policy.feePostAuthor,
    feePostPermlink: params.policy.feePostPermlink,
    requiredVoteWeightBps,
    status: "open",
    createdAt: (params.createdAt ?? new Date()).toISOString()
  };
}

export function assessFeeVote(params: {
  account: VotingAccountSnapshot;
  invoice: FeeInvoice;
  policy: FeePolicy;
}): BillingAssessment {
  const availableFullVoteUsd = getAvailableFullVoteUsd(
    params.account.fullPowerVoteUsd,
    params.account.votingPowerBps
  );
  const settledUsd = roundUsd(
    availableFullVoteUsd * (params.invoice.requiredVoteWeightBps / MAX_BPS)
  );
  const missingUsd = roundUsd(Math.max(0, params.invoice.amountUsd - settledUsd));
  const warnings: string[] = [];

  if (missingUsd <= 0) {
    return {
      invoice: { ...params.invoice, status: "settled" },
      accountStatus: "active",
      settledUsd,
      missingUsd,
      warnings
    };
  }

  const failures = params.account.consecutiveUnderfundedFees + 1;
  const accountStatus = nextBillingStatus(failures, params.policy);

  warnings.push(
    `Die Voting Power reicht nicht aus, um die Gebuehr vollstaendig zu begleichen. Es fehlen ${missingUsd.toFixed(2)} USD.`
  );

  if (accountStatus === "paused") {
    warnings.push("Der Account wird pausiert, bis wieder genuegend Voting Power vorhanden ist.");
  }

  if (accountStatus === "payment_required") {
    warnings.push("Automatische Freischaltung ist blockiert. Manuelle Zahlung oder Admin-Freigabe erforderlich.");
  }

  return {
    invoice: { ...params.invoice, status: "underfunded" },
    accountStatus,
    settledUsd,
    missingUsd,
    warnings
  };
}

function nextBillingStatus(failures: number, policy: FeePolicy): AccountBillingStatus {
  if (failures > policy.pauseAfterFailures + 2) {
    return "payment_required";
  }
  if (failures >= policy.pauseAfterFailures) {
    return "paused";
  }
  if (failures >= policy.warningAfterFailures) {
    return "warning";
  }
  return "active";
}
