import type { BillingMode, FeeInvoice, OperatorOverview, OperatorRevenueAccount, VotingAccountSnapshot } from "./types.js";
import { roundUsd } from "./voteMath.js";

function sum(values: number[]): number {
  return roundUsd(values.reduce((total, value) => total + value, 0));
}

function emptyModes(): Record<BillingMode, number> {
  return {
    free: 0,
    donation: 0,
    billable: 0,
    grace: 0,
    paused: 0
  };
}

export function createOperatorOverview(params: {
  accounts: VotingAccountSnapshot[];
  invoices: FeeInvoice[];
  now?: Date;
}): OperatorOverview {
  const settledInvoices = params.invoices.filter((invoice) => invoice.status === "settled");
  const openInvoices = params.invoices.filter((invoice) => invoice.status === "open");
  const underfundedInvoices = params.invoices.filter((invoice) => invoice.status === "underfunded");
  const waivedInvoices = params.invoices.filter((invoice) => invoice.status === "waived");
  const donationInvoices = params.invoices.filter((invoice) => invoice.status === "donation_optional");
  const requiredInvoices = params.invoices.filter((invoice) => invoice.transparency.feeRequired);
  const coveredRequiredUsd = sum(settledInvoices.map((invoice) => invoice.amountUsd));
  const totalRequiredUsd = sum(requiredInvoices.map((invoice) => invoice.amountUsd));
  const billingModes = params.invoices.reduce((modes, invoice) => {
    modes[invoice.billingMode] += 1;
    return modes;
  }, emptyModes());

  const byAccount = new Map<string, OperatorRevenueAccount>();
  for (const invoice of params.invoices) {
    const entry = byAccount.get(invoice.username) ?? {
      username: invoice.username,
      settledFeeUsd: 0,
      pendingFeeUsd: 0,
      waivedFeeUsd: 0,
      invoiceCount: 0
    };
    entry.invoiceCount += 1;
    if (invoice.status === "settled") entry.settledFeeUsd += invoice.amountUsd;
    if (invoice.status === "open" || invoice.status === "underfunded") entry.pendingFeeUsd += invoice.amountUsd;
    if (invoice.status === "waived" || invoice.status === "donation_optional") entry.waivedFeeUsd += invoice.nominalFeeUsd;
    byAccount.set(invoice.username, entry);
  }

  const topAccounts = [...byAccount.values()]
    .map((account) => ({
      ...account,
      settledFeeUsd: roundUsd(account.settledFeeUsd),
      pendingFeeUsd: roundUsd(account.pendingFeeUsd),
      waivedFeeUsd: roundUsd(account.waivedFeeUsd)
    }))
    .sort((left, right) => right.settledFeeUsd + right.pendingFeeUsd - (left.settledFeeUsd + left.pendingFeeUsd))
    .slice(0, 8);

  return {
    generatedAt: (params.now ?? new Date()).toISOString(),
    revenue: {
      settledFeeUsd: coveredRequiredUsd,
      pendingFeeUsd: sum(openInvoices.map((invoice) => invoice.amountUsd)),
      underfundedFeeUsd: sum(underfundedInvoices.map((invoice) => invoice.amountUsd)),
      waivedFeeUsd: sum(waivedInvoices.map((invoice) => invoice.nominalFeeUsd)),
      donationValueUsd: 0,
      donationOpportunityUsd: sum(donationInvoices.map((invoice) => invoice.nominalFeeUsd)),
      curationMovedUsd: sum(params.invoices.map((invoice) => invoice.sourceExpectedVoteUsd)),
      feeCoveragePct: totalRequiredUsd <= 0 ? 0 : Math.round((coveredRequiredUsd / totalRequiredUsd) * 100)
    },
    invoices: {
      total: params.invoices.length,
      settled: settledInvoices.length,
      open: openInvoices.length,
      underfunded: underfundedInvoices.length,
      waived: waivedInvoices.length,
      donationOptional: donationInvoices.length
    },
    accounts: {
      total: params.accounts.length,
      active: params.accounts.filter((account) => account.status === "active").length,
      warning: params.accounts.filter((account) => account.status === "warning").length,
      paused: params.accounts.filter((account) => account.status === "paused").length,
      paymentRequired: params.accounts.filter((account) => account.status === "payment_required").length
    },
    billingModes,
    topAccounts,
    recentInvoices: [...params.invoices]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 10)
  };
}
