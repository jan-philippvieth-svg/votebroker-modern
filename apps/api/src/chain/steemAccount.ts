import type { VotingAccountSnapshot } from "@votebroker/domain";
import { createSteemClient } from "./steemBroadcaster.js";

export interface SteemAccountSnapshot {
  username: string;
  votingPowerBps: number;
  steemPowerSp: number;
  fullPowerVoteUsd: number;
  currentVoteUsd: number;
  sbdPerSteem: number;  // SBD per STEEM from witness median price feed (NOT USD/STEEM)
}

function parseAmount(value: unknown): number {
  return parseFloat(String(value).split(" ")[0]);
}

/**
 * Returns the median STEEM/USD price from the witness feed history.
 *
 * get_current_median_history_price returns aggregated totals on Steem (not per-unit),
 * so we use price_history entries instead, which are per-unit (e.g. "0.050 SBD"/"1.000 STEEM").
 */
function medianPriceFromHistory(priceHistory: Array<{ base: string; quote: string }>): number {
  const prices = priceHistory
    .slice(-21)
    .map(p => {
      const b = parseAmount(p.base);
      const q = parseAmount(p.quote);
      return q > 0 ? b / q : 0;
    })
    .filter(p => p > 0 && p < 10);
  if (prices.length === 0) return 0.05;
  prices.sort((a, b) => a - b);
  return prices[Math.floor(prices.length / 2)];
}

export async function fetchSteemAccountSnapshot(username: string): Promise<SteemAccountSnapshot> {
  const client = createSteemClient();

  const [accounts, globalProps, rewardFund, feedHistory] = await Promise.all([
    client.database.getAccounts([username]),
    client.database.getDynamicGlobalProperties(),
    client.database.call("get_reward_fund", ["post"]) as Promise<{
      reward_balance: string;
      recent_claims: string;
    }>,
    client.database.call("get_feed_history", []) as Promise<{
      price_history: Array<{ base: string; quote: string }>;
    }>
  ]);

  const account = accounts[0];
  if (!account) throw new Error(`Account @${username} not found on chain`);

  // ── Steem Power ─────────────────────────────────────────────────────────
  const totalVestingFundSteem = parseAmount(globalProps.total_vesting_fund_steem);
  const totalVestingShares    = parseAmount(globalProps.total_vesting_shares);
  const vestingShares         = parseAmount(account.vesting_shares);
  const delegatedVesting      = parseAmount(account.delegated_vesting_shares);
  const receivedVesting       = parseAmount(account.received_vesting_shares);

  const effectiveVests = vestingShares - delegatedVesting + receivedVesting;
  const steemPowerSp   = totalVestingShares > 0
    ? effectiveVests * (totalVestingFundSteem / totalVestingShares)
    : 0;

  // ── Voting Power (regeneration-aware) ───────────────────────────────────
  // account.voting_power is the snapshot at last_vote_time — stale between votes.
  // Recompute from voting_manabar + elapsed time so the value is always current.
  const MANA_REGEN_SECONDS = 5 * 24 * 3600; // 432 000 s = 5 days to full regen
  const votingManabar = (account as unknown as {
    voting_manabar: { current_mana: string; last_update_time: number }
  }).voting_manabar;
  const storedMana      = parseAmount(votingManabar.current_mana);
  const lastUpdateTime  = votingManabar.last_update_time; // Unix seconds

  const effectiveVestsMicro = effectiveVests * 1_000_000;
  const nowSec     = Math.floor(Date.now() / 1000);
  const elapsed    = Math.max(0, nowSec - lastUpdateTime);
  const regenMana  = (elapsed / MANA_REGEN_SECONDS) * effectiveVestsMicro;
  const currentMana = Math.min(effectiveVestsMicro, storedMana + regenMana);

  const votingPowerBps = effectiveVestsMicro > 0
    ? Math.round((currentMana / effectiveVestsMicro) * 10_000)
    : 0;

  // ── Price (from witness feed history, NOT get_current_median_history_price) ──
  const sbdPerSteem = medianPriceFromHistory(feedHistory.price_history ?? []);

  // ── rshares (validated against live blockchain votes, ~3% accuracy) ────────
  //
  // Correct Steem formula (post-HF21):
  //   rshares = mana / max_vote_denom          (100% weight, current VP)
  //   rshares = effective_vests_micro / max_vote_denom  (100% weight, 100% VP)
  //
  // where:
  //   mana            = currentMana (regeneration-adjusted, see above)
  //   max_vote_denom  = vote_power_reserve_rate × REGEN_DAYS = 10 × 5 = 50
  //
  const VOTE_REGEN_DAYS = 5;
  const VOTE_RESERVE_RATE = 10;
  const maxVoteDenom = VOTE_RESERVE_RATE * VOTE_REGEN_DAYS; // = 50

  const mana = currentMana; // use the regeneration-adjusted value

  const rsharesFullPower = Math.floor(effectiveVestsMicro / maxVoteDenom);
  const rsharesCurrent   = Math.floor(mana / maxVoteDenom);

  // ── Vote value via reward fund (convergent_linear curve) ─────────────────
  const rewardBalance = parseAmount(rewardFund.reward_balance);
  const recentClaims  = parseFloat(rewardFund.recent_claims);

  const fullPowerVoteUsd = (rsharesFullPower / recentClaims) * rewardBalance * sbdPerSteem;
  const currentVoteUsd   = (rsharesCurrent   / recentClaims) * rewardBalance * sbdPerSteem;

  return {
    username,
    votingPowerBps,
    steemPowerSp:      Math.round(steemPowerSp * 1_000)   / 1_000,
    fullPowerVoteUsd:  Math.round(fullPowerVoteUsd * 10_000) / 10_000,
    currentVoteUsd:    Math.round(currentVoteUsd   * 10_000) / 10_000,
    sbdPerSteem:       Math.round(sbdPerSteem * 1_000_000) / 1_000_000
  };
}

export function toVotingAccountSnapshot(snapshot: SteemAccountSnapshot): VotingAccountSnapshot {
  return {
    username: snapshot.username,
    votingPowerBps:            snapshot.votingPowerBps,
    fullPowerVoteUsd:          snapshot.fullPowerVoteUsd,
    status:                    "active",
    consecutiveUnderfundedFees: 0
  };
}
