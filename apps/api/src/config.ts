import type { FeePolicy } from "@votebroker/domain";

export const feePolicy: FeePolicy = {
  feeBps: Number(process.env.VOTEBROKER_FEE_BPS ?? 300),
  minFeeUsd: Number(process.env.VOTEBROKER_MIN_FEE_USD ?? 0.05),
  feePostAuthor: process.env.VOTEBROKER_FEE_POST_AUTHOR ?? "votebroker",
  feePostPermlink: process.env.VOTEBROKER_FEE_POST_PERMLINK ?? "monthly-fees",
  warningAfterFailures: Number(process.env.VOTEBROKER_WARNING_AFTER_FAILURES ?? 2),
  pauseAfterFailures: Number(process.env.VOTEBROKER_PAUSE_AFTER_FAILURES ?? 4)
};
