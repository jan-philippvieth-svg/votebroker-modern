import { Client, PrivateKey } from "dsteem";
import {
  buildDailyFeePostBody,
  dailyFeePostPermlink,
  type SystemStatus
} from "@votebroker/domain";
import { broadcastConfig, steemNetworkConfig } from "../config.js";
import { getSteemConnectConfig } from "../auth/steemConnectConfig.js";
import { changelogEntries, knownIssues } from "../changelog/entries.js";
import { createSteemClient } from "./steemBroadcaster.js";

const RC_MIN_PCT   = 10;   // Abort if < 10% RC remaining — post would likely fail anyway
const MAX_RETRIES  = 3;
const RETRY_BASE_MS = 4_000;

async function checkRcPreflight(client: Client, account: string): Promise<void> {
  try {
    const result = await client.database.call("rc_api.find_rc_accounts", {
      accounts: [account]
    }) as { rc_accounts?: Array<{ max_rc: string; rc_manabar: { current_mana: string } }> };

    const rc = result?.rc_accounts?.[0];
    if (!rc) return;

    const maxRc     = Number(rc.max_rc);
    const currentRc = Number(rc.rc_manabar.current_mana);
    const pct       = maxRc > 0 ? (currentRc / maxRc) * 100 : 100;

    if (pct < RC_MIN_PCT) {
      throw new Error(
        `RC preflight failed for @${account}: ${pct.toFixed(1)}% remaining (min ${RC_MIN_PCT}%)`
      );
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("RC preflight")) throw err;
    // rc_api unavailable on this node — proceed without check
  }
}

async function broadcastWithRetry(fn: () => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fn();
      return;
    } catch (err: unknown) {
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * attempt));
    }
  }
}

export interface EnsureFeePostResult {
  permlink: string;
  alreadyExisted: boolean;
  author: string;
}

/**
 * Derives system status from what is actually configured and running.
 * No external API calls — purely based on config and known feature states.
 */
function deriveSystemStatus(params: {
  hasClientSecret: boolean;
  hasPostingWif: boolean;
}): SystemStatus {
  const auth: SystemStatus["oauth"] = params.hasClientSecret ? "live" : "preview";
  const votes: SystemStatus["voting"] = params.hasPostingWif ? "live" : "preview";
  return {
    oauth:     auth,
    authority: params.hasPostingWif ? "live" : "preview",
    voteDna:   "beta",  // Promoted to live once persistent vote log exists
    voting:    votes,
    billing:   "beta",  // Promoted to live once invoice persistence is added
    feePost:   params.hasPostingWif ? "live" : "preview"
  };
}

export async function ensureDailyFeePost(params: {
  date?: Date;
  newUsers?: string[];
}): Promise<EnsureFeePostResult> {
  const date   = params.date ?? new Date();
  const author = broadcastConfig.account;
  const permlink = dailyFeePostPermlink(date);
  const client = createSteemClient();

  // Idempotency: check if the post already exists
  const existing = await client.database.call("get_content", [author, permlink]) as {
    author?: string;
  };
  if (existing?.author === author) {
    return { permlink, alreadyExisted: true, author };
  }

  if (!broadcastConfig.postingWif) {
    throw new Error("VOTEBROKER_POSTING_WIF is not configured — cannot publish fee post");
  }

  await checkRcPreflight(client, author);

  const systemStatus = deriveSystemStatus({
    hasClientSecret: Boolean(getSteemConnectConfig().clientSecret),
    hasPostingWif:   Boolean(broadcastConfig.postingWif)
  });

  const { title, body } = buildDailyFeePostBody({
    date,
    newUsers: params.newUsers,
    changelog: changelogEntries,
    knownIssues,
    systemStatus
  });

  const key = PrivateKey.fromString(broadcastConfig.postingWif);

  await broadcastWithRetry(() =>
    client.broadcast.comment(
      {
        parent_author:   "",
        parent_permlink: "steem",
        author,
        permlink,
        title,
        body,
        json_metadata: JSON.stringify({
          tags: ["votebroker", "fees", "curation"],
          app: "votebroker/1.0"
        })
      },
      key
    )
  );

  return { permlink, alreadyExisted: false, author };
}
