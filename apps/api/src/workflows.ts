import { createFeeInvoice, dailyFeePostPermlink, quoteUsdVote } from "@votebroker/domain";
import { randomUUID } from "node:crypto";
import { feePolicy } from "./config.js";
import { fetchSteemAccountSnapshot, toVotingAccountSnapshot } from "./chain/steemAccount.js";
import { getAccount } from "./mockStore.js";
import { saveInvoice } from "./billing/billingStore.js";
import type { VoteBrokerWorkflow } from "./ports.js";

export const voteBrokerWorkflow: VoteBrokerWorkflow = {
  async quotePostVote(params) {
    let account = getAccount(params.username);
    try {
      const snapshot = await fetchSteemAccountSnapshot(params.username);
      account = toVotingAccountSnapshot(snapshot);
    } catch {
      // fall back to mockStore (e.g. "demo" account or Steem API unavailable)
    }
    const quote = quoteUsdVote({
      author: params.author,
      permlink: params.permlink,
      desiredVoteUsd: params.desiredVoteUsd,
      account,
      timing: {
        mode: params.timingMode ?? "auto",
        delayMinutes: params.voteDelayMinutes,
        postCreatedAt: params.postCreatedAt
      },
      powerRecommendation: {
        plannedVotesToday: params.plannedVotesToday ?? 10,
        targetVotingPowerBps: params.targetVotingPowerBps ?? 8_000
      }
    });
    const invoice = createFeeInvoice({
      id: randomUUID(),
      account,
      quote,
      policy: feePolicy,
      feePostPermlink: dailyFeePostPermlink()
    });

    saveInvoice(invoice);   // persisted to SQLite — survives restarts

    return { account, quote, invoice };
  }
};
