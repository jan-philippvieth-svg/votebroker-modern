import type { FeePolicy } from "@votebroker/domain";

export { DEFAULT_TIMEZONE } from "./utils/timezone.js";

export const feePolicy: FeePolicy = {
  feeBps: Number(process.env.VOTEBROKER_FEE_BPS ?? 300),
  minFeeUsd: Number(process.env.VOTEBROKER_MIN_FEE_USD ?? 0.05),
  feePostAuthor: process.env.VOTEBROKER_FEE_POST_AUTHOR ?? "votebroker",
  warningAfterFailures: Number(process.env.VOTEBROKER_WARNING_AFTER_FAILURES ?? 2),
  pauseAfterFailures: Number(process.env.VOTEBROKER_PAUSE_AFTER_FAILURES ?? 4),
  freeUntilVoteUsd: Number(process.env.VOTEBROKER_FREE_UNTIL_VOTE_USD ?? 0.25),
  donationUntilVoteUsd: Number(process.env.VOTEBROKER_DONATION_UNTIL_VOTE_USD ?? 1),
  maxFeeVoteWeightBps: Number(process.env.VOTEBROKER_MAX_FEE_VOTE_WEIGHT_BPS ?? 2_000),
  graceConsecutiveFailures: Number(process.env.VOTEBROKER_GRACE_CONSECUTIVE_FAILURES ?? 2)
};

export const operatorConfig = {
  token: process.env.VOTEBROKER_OPERATOR_TOKEN ?? ""
};

// Fee settlement broadcasts a real vote on the user's behalf to pay the service
// fee. The billing flow is not yet validated end-to-end and there are no paying
// users, so it is OFF by default and must be explicitly enabled in production
// (VOTEBROKER_BILLING_ENABLED=true). This guarantees half-finished finance logic
// can never broadcast a fee vote by accident.
export const billingConfig = {
  enabled: process.env.VOTEBROKER_BILLING_ENABLED === "true"
};

// STEEM_NODE_URL may be a single URL or a comma-separated list of fallback
// nodes. dsteem's Client binds to one address (no built-in multi-node
// failover), so the broadcaster rotates through this list — see chain/steemBroadcaster.ts.
const DEFAULT_STEEM_NODES = [
  "https://api.steemit.com",
  "https://api.justyy.com",
  "https://api.steemitdev.com",
  "https://steemapi.boylikegirl.club",
];

function parseNodeList(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (list.length === 0) return DEFAULT_STEEM_NODES;
  // Append the known-good defaults as extra fallbacks (de-duplicated).
  return [...new Set([...list, ...DEFAULT_STEEM_NODES])];
}

export const steemNetworkConfig = {
  /** First configured node — kept for backward-compatibility with existing call sites. */
  nodeUrl: parseNodeList(process.env.STEEM_NODE_URL)[0],
  /** Full ordered failover list. */
  nodeUrls: parseNodeList(process.env.STEEM_NODE_URL),
  chainId: process.env.STEEM_CHAIN_ID ?? "0000000000000000000000000000000000000000000000000000000000000000",
  addressPrefix: process.env.STEEM_ADDRESS_PREFIX ?? "STM"
};

export const broadcastConfig = {
  account: process.env.VOTEBROKER_BROADCAST_ACCOUNT ?? "votebroker",
  postingWif: process.env.VOTEBROKER_POSTING_WIF ?? "",
  manualTokenFallback: process.env.VOTEBROKER_MANUAL_TOKEN_FALLBACK === "true"
};
