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

// ── Node pool + failover ────────────────────────────────────────────────────
// dsteem's Client binds to a single address with no built-in multi-node
// failover. We keep an ordered node list (config) and a module-level pointer to
// the currently-healthy node. `withSteemFailover` rotates the pointer on error;
// every plain `createSteemClient()` caller then follows to the healthy node
// without needing its own failover logic.

const RPC_TIMEOUT_MS = 8_000;
let _activeNodeIndex = 0;

function clientForNode(url: string): Client {
  return new Client(url, {
    addressPrefix: steemNetworkConfig.addressPrefix,
    chainId:       steemNetworkConfig.chainId,
    timeout:       RPC_TIMEOUT_MS,   // also retries with backoff on the same node within this budget
  });
}

export function getActiveSteemNode(): string {
  const nodes = steemNetworkConfig.nodeUrls;
  return nodes[_activeNodeIndex % nodes.length];
}

export function createSteemClient(): Client {
  return clientForNode(getActiveSteemNode());
}

/**
 * Run an operation against the active Steem node, failing over to the next node
 * in the list on error. On success the active-node pointer sticks, so every
 * subsequent `createSteemClient()` call also uses the node that just worked.
 */
export async function withSteemFailover<T>(
  fn: (client: Client) => Promise<T>,
  log?: { warn: (msg: string) => void },
): Promise<T> {
  const nodes = steemNetworkConfig.nodeUrls;
  let lastErr: unknown;
  for (let attempt = 0; attempt < nodes.length; attempt++) {
    const idx = (_activeNodeIndex + attempt) % nodes.length;
    try {
      const result = await fn(clientForNode(nodes[idx]));
      _activeNodeIndex = idx;   // stick to the node that worked
      return result;
    } catch (err) {
      lastErr = err;
      log?.warn(
        `[Steem] node ${nodes[idx]} failed (attempt ${attempt + 1}/${nodes.length}): ` +
        (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all Steem nodes failed");
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
}): Promise<{ transactionId: string; confirmed: boolean }> {
  requireBroadcastConfig(broadcastConfig);
  const key = PrivateKey.fromString(broadcastConfig.postingWif);

  const doVote = async (client: Client): Promise<{ transactionId: string; confirmed: boolean }> => {
    const result = await client.broadcast.vote({
      voter:    params.voter,
      author:   params.author,
      permlink: params.permlink,
      weight:   params.weightBps
    }, key);

    // A confirmed broadcast has a 40-char hex transaction ID
    const txId = result.id ?? "";
    if (!txId) {
      throw new Error(
        `Vote broadcast returned no transaction ID — the Steem node may have rejected the transaction. ` +
        `voter=${params.voter} author=${params.author} permlink=${params.permlink} weight=${params.weightBps}`
      );
    }
    return { transactionId: txId, confirmed: /^[0-9a-f]{40}$/i.test(txId) };
  };

  // When the caller supplies a client (it already did an authority check on that
  // node), reuse it. Otherwise broadcast through the failover pool.
  // Note: a vote is effectively idempotent on-chain — a retry after a timeout
  // either lands or returns "already voted", which callers already handle.
  return params.client ? doVote(params.client) : withSteemFailover(doVote);
}
