import { MAX_BPS, clampBps, getAvailableFullVoteUsd, roundUsd } from "./voteMath.js";
import type {
  AccountBillingStatus,
  BillingAssessment,
  BillingMode,
  BillingTransparency,
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
  feePostPermlink: string;
  createdAt?: Date;
}): FeeInvoice {
  const rawFeeUsd = Math.max(
    params.policy.minFeeUsd,
    params.quote.expectedVoteUsd * (params.policy.feeBps / MAX_BPS)
  );
  const availableFullVoteUsd = getAvailableFullVoteUsd(
    params.account.fullPowerVoteUsd,
    params.account.votingPowerBps
  );
  const billing = decideBillingMode({
    account: params.account,
    availableFullVoteUsd,
    policy: params.policy,
    quote: params.quote,
    rawFeeUsd
  });
  const amountUsd = billing.feeRequired ? rawFeeUsd : 0;
  const requiredVoteWeightBps =
    availableFullVoteUsd <= 0 ? MAX_BPS : clampBps((amountUsd / availableFullVoteUsd) * MAX_BPS);

  return {
    id: params.id,
    username: params.account.username,
    sourceAuthor: params.quote.author,
    sourcePermlink: params.quote.permlink,
    sourceExpectedVoteUsd: params.quote.expectedVoteUsd,
    nominalFeeUsd: roundUsd(rawFeeUsd),
    amountUsd: roundUsd(amountUsd),
    feePostAuthor: params.policy.feePostAuthor,
    feePostPermlink: params.feePostPermlink,
    requiredVoteWeightBps,
    status: billing.feeRequired ? "open" : billing.mode === "donation" ? "donation_optional" : "waived",
    billingMode: billing.mode,
    transparency: billing.transparency,
    createdAt: (params.createdAt ?? new Date()).toISOString()
  };
}

export function assessFeeVote(params: {
  account: VotingAccountSnapshot;
  invoice: FeeInvoice;
  policy: FeePolicy;
}): BillingAssessment {
  if (!params.invoice.transparency.feeRequired) {
    return {
      invoice: { ...params.invoice, status: params.invoice.status },
      accountStatus: params.account.status,
      settledUsd: 0,
      missingUsd: 0,
      warnings: []
    };
  }

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

function decideBillingMode(params: {
  account: VotingAccountSnapshot;
  availableFullVoteUsd: number;
  policy: FeePolicy;
  quote: VoteQuote;
  rawFeeUsd: number;
}): { mode: BillingMode; feeRequired: boolean; transparency: BillingTransparency } {
  const requiredFeeVoteWeightBps = params.availableFullVoteUsd <= 0
    ? MAX_BPS
    : clampBps((params.rawFeeUsd / params.availableFullVoteUsd) * MAX_BPS);
  const reasons: string[] = [];

  if (params.account.status === "paused" || params.account.status === "payment_required") {
    reasons.push("Automatisches Billing ist pausiert, bis der Account wieder freigegeben ist.");
    return makeBillingDecision("paused", false, reasons, requiredFeeVoteWeightBps);
  }

  if (params.quote.expectedVoteUsd <= params.policy.freeUntilVoteUsd) {
    reasons.push(`Der Vote liegt unter dem Free-Fair-Use-Limit von ${params.policy.freeUntilVoteUsd.toFixed(2)} USD.`);
    reasons.push("Es wird keine Rechnung erzeugt und keine versteckte Gebuehr gesammelt.");
    return makeBillingDecision("free", false, reasons, requiredFeeVoteWeightBps);
  }

  if (
    params.quote.expectedVoteUsd <= params.policy.donationUntilVoteUsd
    || requiredFeeVoteWeightBps > params.policy.maxFeeVoteWeightBps
  ) {
    reasons.push("Die faire Gebuehr waere im Verhaeltnis zur aktuellen Voting Power zu teuer.");
    reasons.push("Der Nutzer kann freiwillig per Support-Vote helfen, muss aber nicht zahlen.");
    return makeBillingDecision("donation", false, reasons, requiredFeeVoteWeightBps);
  }

  if (params.account.consecutiveUnderfundedFees > 0 && params.account.consecutiveUnderfundedFees <= params.policy.graceConsecutiveFailures) {
    reasons.push("Der Account hatte zuletzt unterdeckte Fee-Votes, ist aber noch in der Grace-Phase.");
    reasons.push("VoteBroker warnt transparent, blockiert neue Nutzung aber noch nicht.");
    return makeBillingDecision("grace", true, reasons, requiredFeeVoteWeightBps);
  }

  reasons.push("Der Account kann die Fee voraussichtlich mit angemessenem Vote-Gewicht decken.");
  reasons.push("Die Gebuehr wird transparent ueber den ausgewiesenen Fee-Post-Vote beglichen.");
  return makeBillingDecision("billable", true, reasons, requiredFeeVoteWeightBps);
}

function makeBillingDecision(
  mode: BillingMode,
  feeRequired: boolean,
  reasons: string[],
  requiredFeeVoteWeightBps: number
): { mode: BillingMode; feeRequired: boolean; transparency: BillingTransparency } {
  const copy: Record<BillingMode, Omit<BillingTransparency, "reasons">> = {
    free: {
      headline: "Free Mode",
      detail: "Dieser Account nutzt VoteBroker aktuell kostenlos.",
      userMessage: "Du zahlst nichts. Es werden keine offenen Gebuehren angesammelt.",
      donationAllowed: true,
      feeRequired: false
    },
    donation: {
      headline: "Donation Mode",
      detail: "Eine Pflichtgebuehr waere fuer diesen Account aktuell nicht fair.",
      userMessage: "Du kannst VoteBroker freiwillig per Support-Vote helfen, musst aber nicht.",
      donationAllowed: true,
      feeRequired: false
    },
    billable: {
      headline: "Billable Mode",
      detail: `Die Fee kann voraussichtlich mit ${(requiredFeeVoteWeightBps / 100).toFixed(2)}% Vote-Gewicht gedeckt werden.`,
      userMessage: "Die Plattformgebuehr wird transparent per Fee-Post-Vote beglichen.",
      donationAllowed: false,
      feeRequired: true
    },
    grace: {
      headline: "Grace Mode",
      detail: "Der Account bekommt eine faire Schonphase statt sofortiger Sperre.",
      userMessage: "VoteBroker warnt dich, laesst dich aber noch weiterarbeiten.",
      donationAllowed: true,
      feeRequired: true
    },
    paused: {
      headline: "Paused Mode",
      detail: "Automatische Billing-Aktionen sind voruebergehend gestoppt.",
      userMessage: "Neue Pflichtgebuehren werden nicht erzeugt, bis der Account wieder gesund ist.",
      donationAllowed: true,
      feeRequired: false
    }
  };

  return {
    mode,
    feeRequired,
    transparency: {
      ...copy[mode],
      reasons
    }
  };
}
