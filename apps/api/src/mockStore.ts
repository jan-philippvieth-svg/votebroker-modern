import type { FeeInvoice, VotingAccountSnapshot } from "@votebroker/domain";

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
