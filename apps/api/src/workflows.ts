import { createFeeInvoice, quoteUsdVote } from "@votebroker/domain";
import { randomUUID } from "node:crypto";
import { feePolicy } from "./config.js";
import { getAccount, invoices } from "./mockStore.js";
import type { VoteBrokerWorkflow } from "./ports.js";

export const voteBrokerWorkflow: VoteBrokerWorkflow = {
  async quotePostVote(params) {
    const account = getAccount(params.username);
    const quote = quoteUsdVote({
      author: params.author,
      permlink: params.permlink,
      desiredVoteUsd: params.desiredVoteUsd,
      account
    });
    const invoice = createFeeInvoice({
      id: randomUUID(),
      account,
      quote,
      policy: feePolicy
    });

    invoices.set(invoice.id, invoice);

    return { account, quote, invoice };
  }
};
