import { Client, PrivateKey, type ExtendedAccount } from "dsteem";
import { broadcastConfig, steemNetworkConfig } from "../config.js";

export interface BroadcastConfig {
  account: string;
  postingWif: string;
}

export interface VoteBroadcastPreconditions {
  hasConsent: boolean;
  hasPostingAuthority: boolean;
  hasPostingWif: boolean;
  accountStatus: "active" | "warning" | "paused" | "payment_required";
  fullPowerVoteUsd: number;
  weightBps: number;
}

export type VoteBroadcastBlockReason =
  | "missing_consent"
  | "missing_posting_wif"
  | "missing_posting_authority"
  | "account_paused"
  | "implausible_quote"
  | "invalid_weight";

export interface VoteBroadcastPolicyResult {
  allowed: boolean;
  reason?: VoteBroadcastBlockReason;
}

export function requireBroadcastConfig(config: BroadcastConfig): void {
  if (!config.account) {
    throw new Error("VOTEBROKER_BROADCAST_ACCOUNT is not configured");
  }
  if (!config.postingWif) {
    throw new Error("VOTEBROKER_POSTING_WIF is not configured");
  }
}

export function hasPostingAuthority(account: Pick<ExtendedAccount, "posting">, broadcastAccount: string): boolean {
  return account.posting.account_auths.some(([name, weight]) => (
    name === broadcastAccount && weight >= account.posting.weight_threshold
  ));
}

export function evaluateVoteBroadcastPolicy(params: VoteBroadcastPreconditions): VoteBroadcastPolicyResult {
  if (!params.hasConsent) return { allowed: false, reason: "missing_consent" };
  if (!params.hasPostingWif) return { allowed: false, reason: "missing_posting_wif" };
  if (!params.hasPostingAuthority) return { allowed: false, reason: "missing_posting_authority" };
  if (params.accountStatus === "paused" || params.accountStatus === "payment_required") {
    return { allowed: false, reason: "account_paused" };
  }
  if (params.fullPowerVoteUsd <= 0) return { allowed: false, reason: "implausible_quote" };
  if (!Number.isSafeInteger(params.weightBps) || params.weightBps < 1 || params.weightBps > 10_000) {
    return { allowed: false, reason: "invalid_weight" };
  }
  return { allowed: true };
}

export function createSteemClient(): Client {
  return new Client(steemNetworkConfig.nodeUrl, {
    addressPrefix: steemNetworkConfig.addressPrefix,
    chainId: steemNetworkConfig.chainId
  });
}

export async function getPostingAuthority(params: {
  client: Client;
  username: string;
  broadcastAccount?: string;
}): Promise<boolean> {
  const [account] = await params.client.database.getAccounts([params.username]);
  if (!account) {
    return false;
  }
  return hasPostingAuthority(account, params.broadcastAccount ?? broadcastConfig.account);
}

export async function broadcastServerSideVote(params: {
  client?: Client;
  voter: string;
  author: string;
  permlink: string;
  weightBps: number;
}): Promise<{ transactionId: string }> {
  requireBroadcastConfig(broadcastConfig);
  const client = params.client ?? createSteemClient();
  const key = PrivateKey.fromString(broadcastConfig.postingWif);
  const result = await client.broadcast.vote({
    voter: params.voter,
    author: params.author,
    permlink: params.permlink,
    weight: params.weightBps
  }, key);

  return {
    transactionId: result.id ?? "broadcast_accepted"
  };
}
