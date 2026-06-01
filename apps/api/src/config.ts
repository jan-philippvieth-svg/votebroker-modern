import type { FeePolicy } from "@votebroker/domain";

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

export const steemNetworkConfig = {
  nodeUrl: process.env.STEEM_NODE_URL ?? "https://api.steemit.com",
  chainId: process.env.STEEM_CHAIN_ID ?? "0000000000000000000000000000000000000000000000000000000000000000",
  addressPrefix: process.env.STEEM_ADDRESS_PREFIX ?? "STM"
};

export const broadcastConfig = {
  account: process.env.VOTEBROKER_BROADCAST_ACCOUNT ?? "votebroker",
  postingWif: process.env.VOTEBROKER_POSTING_WIF ?? "",
  manualTokenFallback: process.env.VOTEBROKER_MANUAL_TOKEN_FALLBACK === "true"
};
