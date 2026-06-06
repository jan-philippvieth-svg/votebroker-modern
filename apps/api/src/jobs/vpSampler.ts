import { getDb } from "../db/index.js";
import { createSteemClient } from "../chain/steemBroadcaster.js";

const INTERVAL_MS = 15 * 60 * 1_000; // 15 minutes

let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;

function calcVpBps(account: {
  voting_manabar?:           { current_mana: string | number; last_update_time: number };
  vesting_shares?:           string;
  delegated_vesting_shares?: string;
  received_vesting_shares?:  string;
}): number | null {
  if (!account.voting_manabar) return null;
  const mb       = account.voting_manabar;
  const vests    = parseFloat(String(account.vesting_shares             ?? "0").split(" ")[0]);
  const delg     = parseFloat(String(account.delegated_vesting_shares   ?? "0").split(" ")[0]);
  const recv     = parseFloat(String(account.received_vesting_shares    ?? "0").split(" ")[0]);
  const effMicro = (vests - delg + recv) * 1_000_000;
  if (effMicro <= 0) return null;
  const stored   = Number(mb.current_mana);
  const nowSec   = Math.floor(Date.now() / 1_000);
  const regen    = ((nowSec - mb.last_update_time) / (5 * 86_400)) * effMicro;
  const cur      = Math.min(effMicro, stored + regen);
  return Math.round((cur / effMicro) * 10_000);
}

export async function runVpSampler(log: typeof console = console): Promise<void> {
  const db = getDb();

  // Collect distinct usernames with non-expired sessions
  const rows = db.prepare(
    "SELECT DISTINCT username FROM sessions WHERE expiry > datetime('now')"
  ).all() as Array<{ username: string }>;

  if (rows.length === 0) return;

  const usernames = rows.map(r => r.username);
  const client    = createSteemClient();
  const sampledAt = new Date().toISOString();

  let accounts: Array<{
    name:                      string;
    vesting_shares?:           string;
    delegated_vesting_shares?: string;
    received_vesting_shares?:  string;
    voting_manabar?:           { current_mana: string | number; last_update_time: number };
  }>;

  try {
    accounts = await client.database.getAccounts(usernames) as typeof accounts;
  } catch (err) {
    log.warn("[VpSampler] getAccounts failed:", err);
    return;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO vb_vp_snapshots (username, sampled_at, vp_bps, sp_approx)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = db.transaction((accs: typeof accounts) => {
    for (const acc of accs) {
      const vpBps = calcVpBps(acc);
      if (vpBps === null) continue;
      const vests   = parseFloat(String(acc.vesting_shares ?? "0").split(" ")[0]);
      const delg    = parseFloat(String(acc.delegated_vesting_shares ?? "0").split(" ")[0]);
      const recv    = parseFloat(String(acc.received_vesting_shares  ?? "0").split(" ")[0]);
      const spApprox = Math.round((vests - delg + recv) * 1_000) / 1_000;
      insert.run(acc.name, sampledAt, vpBps, spApprox);
    }
  });

  insertMany(accounts);
  log.info(`[VpSampler] Sampled VP for ${accounts.length} user(s) at ${sampledAt}`);
}

export function startVpSampler(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  function schedule(): void {
    _timer = setTimeout(async () => {
      try { await runVpSampler(log); } catch (err) { log.warn("[VpSampler] error:", err); }
      schedule();
    }, INTERVAL_MS);
  }

  // Run once immediately so we have data right away, then schedule repeating
  runVpSampler(log).catch(err => log.warn("[VpSampler] initial run error:", err));
  schedule();
  log.info(`[VpSampler] Started — sampling every ${INTERVAL_MS / 60_000} min`);
}

export function stopVpSampler(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
