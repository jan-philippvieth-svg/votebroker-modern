import type { VoteRecord } from "@votebroker/domain";
import { createSteemClient } from "./steemBroadcaster.js";

const MAX_OPS_PER_BATCH = 100;  // Steem API hard limit
const DEFAULT_MAX_VOTES = 500;

interface RawHistoryEntry {
  op: [string, Record<string, unknown>];
  timestamp: string;
}

export async function fetchVoteHistory(
  username: string,
  maxVotes = DEFAULT_MAX_VOTES
): Promise<VoteRecord[]> {
  const client = createSteemClient();
  const votes: VoteRecord[] = [];
  let fromSeq = -1;
  const seen = new Set<string>();

  while (votes.length < maxVotes) {
    const batch = await (client.database as unknown as {
      call(method: string, params: unknown[]): Promise<[number, RawHistoryEntry][]>
    }).call("get_account_history", [username, fromSeq, MAX_OPS_PER_BATCH]);

    if (!batch || batch.length === 0) break;

    for (const [, op] of batch) {
      const [opType, opData] = op.op;
      if (
        opType === "vote" &&
        (opData as { voter?: string }).voter === username
      ) {
        const v = opData as { author: string; permlink: string; weight: number };
        const key = `${v.author}/${v.permlink}`;
        if (!seen.has(key)) {
          seen.add(key);
          votes.push({
            author:    v.author,
            permlink:  v.permlink,
            weight:    v.weight,
            timestamp: op.timestamp
          });
        }
      }
    }

    const firstSeq = batch[0][0];
    if (firstSeq <= 1 || batch.length < MAX_OPS_PER_BATCH) break;
    fromSeq = firstSeq - 1;
  }

  // Chronological order (oldest first)
  return votes.reverse();
}
