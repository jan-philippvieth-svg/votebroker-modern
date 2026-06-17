import { createSteemClient } from "./steemBroadcaster.js";
import { getPostCache, setPostCache } from "./postCache.js";

// Steem payout window: exactly 7 days after post creation
const PAYOUT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_AGE_MS       = 5 * 60 * 1000;   // 5 min curation minimum
const WARN_EXPIRY_H    = 24;              // warn when < 24h remaining

export interface PostOpportunity {
  author:            string;
  permlink:          string;
  title:             string;
  ageMinutes:        number;
  remainingHours:    number;
  postScore:         number;
  pendingPayoutSbd:  number;  // pending payout at fetch time — key signal for payout sweetspot
  alreadyVoted:      boolean;
  eligible:          boolean;
  isSelfPost:        boolean;   // author === voterUsername → visibility vote, skip curation timing
  warning:           string | null;
  activeVotesCount:  number;   // number of existing votes — high counts may cause node issues
  community:         string | null; // parent_permlink if it looks like a community (hive-XXXXXX)
}

export interface PostDebugEntry {
  author:      string;
  permlink:    string;
  title:       string;
  createdRaw:  string;
  createdParsed: string;
  ageMinutes:  number | null;
  remainingHours: number | null;
  alreadyVoted: boolean;
  rejectedBy:  string | null;   // null = eligible
}

const HIGH_VOTE_WARN_THRESHOLD = 150; // posts with >150 votes may cause node issues

interface RawPost {
  author:                string;
  permlink:              string;
  title:                 string;
  created:               string;
  pending_payout_value?: string;  // e.g. "1.234 SBD"
  parent_permlink?:      string;  // community name if community post (e.g. "hive-129948")
  active_votes?:         Array<{ voter: string; weight: number }>;
}

function calcPostScore(ageMinutes: number, remainingHours: number): number {
  if (ageMinutes < 5 || remainingHours <= 0) return 0;
  let timingScore: number;
  if      (ageMinutes <= 30)   timingScore = 100;
  else if (ageMinutes <= 60)   timingScore = 92;
  else if (ageMinutes <= 360)  timingScore = 80;
  else if (ageMinutes <= 1440) timingScore = 65;
  else if (ageMinutes <= 4320) timingScore = 40;
  else if (ageMinutes <= 7200) timingScore = 20;
  else                         timingScore = 8;
  const remainingPct = Math.min(1, remainingHours / (PAYOUT_WINDOW_MS / 3_600_000));
  return Math.round(Math.min(100, timingScore + remainingPct * 15));
}

// ── Main fetch ────────────────────────────────────────────────────────────────

export async function fetchRecentPostsWithVotes(
  author: string,
  voterUsername: string,
  limit = 10
): Promise<PostOpportunity[]> {
  const raw = await fetchRawPosts(author, limit);
  if (!raw) return [];
  const nowMs = Date.now();

  return raw
    .filter(post => post.author === author)   // skip reblogs
    .map(post => mapPost(post, voterUsername, nowMs))
    .filter(p => p.remainingHours > 0 || p.alreadyVoted);
}

// ── Debug fetch — returns every post with rejection reason ────────────────────

export async function fetchRecentPostsDebug(
  author: string,
  voterUsername: string,
  limit = 10
): Promise<{ raw: number; debug: PostDebugEntry[]; eligible: PostOpportunity[] }> {
  const raw = await fetchRawPosts(author, limit);
  if (!raw) return { raw: 0, debug: [], eligible: [] };

  const nowMs  = Date.now();
  const debug: PostDebugEntry[] = [];
  const eligible: PostOpportunity[] = [];

  for (const post of raw) {
    // Step 1: reblog check
    if (post.author !== author) {
      debug.push({ author: post.author, permlink: post.permlink, title: post.title, createdRaw: post.created, createdParsed: "—", ageMinutes: null, remainingHours: null, alreadyVoted: false, rejectedBy: `reblog (actual author: ${post.author})` });
      continue;
    }

    // Step 2: parse created
    if (!post.created) {
      debug.push({ author, permlink: post.permlink, title: post.title, createdRaw: "(missing)", createdParsed: "—", ageMinutes: null, remainingHours: null, alreadyVoted: false, rejectedBy: "invalid_created_date: missing" });
      continue;
    }
    const createdStr = post.created.includes("T")
      ? (post.created.endsWith("Z") ? post.created : post.created + "Z")
      : post.created.replace(" ", "T") + "Z";    // handle "YYYY-MM-DD HH:MM:SS" format
    const createdMs  = new Date(createdStr).getTime();

    if (!isFinite(createdMs)) {
      debug.push({ author, permlink: post.permlink, title: post.title, createdRaw: post.created, createdParsed: "NaN", ageMinutes: null, remainingHours: null, alreadyVoted: false, rejectedBy: `invalid_created_date: cannot parse "${post.created}"` });
      continue;
    }

    const ageMs      = nowMs - createdMs;
    const ageMinutes = Math.round(ageMs / 60_000);
    const remainingMs    = PAYOUT_WINDOW_MS - ageMs;
    const remainingHours = Math.max(0, Math.round(remainingMs / 3_600_000 * 10) / 10);
    const alreadyVoted   = post.active_votes?.some(v => v.voter === voterUsername) ?? false;

    // Step 3: expiry check
    if (remainingMs <= 0) {
      debug.push({ author, permlink: post.permlink, title: post.title, createdRaw: post.created, createdParsed: createdStr, ageMinutes, remainingHours: 0, alreadyVoted, rejectedBy: `expired (${ageMinutes} min old, 7-day window closed)` });
      continue;
    }

    // Step 4: already voted check
    if (alreadyVoted) {
      debug.push({ author, permlink: post.permlink, title: post.title, createdRaw: post.created, createdParsed: createdStr, ageMinutes, remainingHours, alreadyVoted, rejectedBy: "already_voted" });
      eligible.push(mapPost(post, voterUsername, nowMs));
      continue;
    }

    // Step 5: too new — self-posts bypass this (visibility > curation timing)
    const isSelfPost = author === voterUsername;
    if (!isSelfPost && ageMs < MIN_AGE_MS) {
      debug.push({ author, permlink: post.permlink, title: post.title, createdRaw: post.created, createdParsed: createdStr, ageMinutes, remainingHours, alreadyVoted, rejectedBy: `too_new (${ageMinutes} min < 5 min minimum)` });
      continue;
    }

    // ✓ Eligible
    debug.push({ author, permlink: post.permlink, title: post.title, createdRaw: post.created, createdParsed: createdStr, ageMinutes, remainingHours, alreadyVoted, rejectedBy: null });
    eligible.push(mapPost(post, voterUsername, nowMs));
  }

  return { raw: raw.length, debug, eligible };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 8_000;

async function fetchRawPosts(author: string, limit: number): Promise<RawPost[] | null> {
  const cached = getPostCache<RawPost>(author);
  if (cached) return cached;

  const client = createSteemClient();
  const db = client.database as unknown as {
    call(method: string, params: unknown[]): Promise<RawPost[]>
  };
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("steem_timeout")), FETCH_TIMEOUT_MS)
    );
    const posts = await Promise.race([
      db.call("get_discussions_by_blog", [{ tag: author, limit }]),
      timeout,
    ]);
    if (Array.isArray(posts)) {
      setPostCache<RawPost>(author, posts);
      return posts;
    }
    return null;
  } catch {
    return null;
  }
}

function parseCreatedMs(created: string): number {
  // Handle "YYYY-MM-DDTHH:MM:SS" and "YYYY-MM-DD HH:MM:SS" formats
  const str = created.includes("T")
    ? (created.endsWith("Z") ? created : created + "Z")
    : created.replace(" ", "T") + "Z";
  return new Date(str).getTime();
}

function mapPost(post: RawPost, voterUsername: string, nowMs: number): PostOpportunity {
  const createdMs      = parseCreatedMs(post.created);
  const ageMs          = nowMs - createdMs;
  const ageMinutes     = Math.round(ageMs / 60_000);
  const remainingMs    = PAYOUT_WINDOW_MS - ageMs;
  const remainingHours = Math.max(0, Math.round(remainingMs / 3_600_000 * 10) / 10);
  const alreadyVoted   = post.active_votes?.some(v => v.voter === voterUsername) ?? false;
  const isSelfPost     = post.author === voterUsername;

  // Self-posts skip curation timing: goal is visibility, not curation reward.
  // The 5-min minimum only matters for strangers' posts (early vote = less curation).
  // For own posts: vote immediately to maximize Social Proof and ranking.
  const withinWindow = isSelfPost
    ? remainingMs > 0                        // only payout window matters
    : ageMs >= MIN_AGE_MS && remainingMs > 0; // strangers: also needs 5-min minimum

  const eligible   = !alreadyVoted && withinWindow;
  const postScore  = isSelfPost && ageMinutes < 30
    ? 100                                    // self-posts always get top score when fresh
    : calcPostScore(ageMinutes, remainingHours);

  const activeVotesCount = post.active_votes?.length ?? 0;
  const community = post.parent_permlink?.startsWith("hive-") ? post.parent_permlink : null;

  let warning: string | null = null;
  if (eligible && remainingHours > 0 && remainingHours < WARN_EXPIRY_H) {
    warning = remainingHours < 6
      ? `⚡ Nur noch ${remainingHours.toFixed(1)}h bis Auszahlung — letzte Chance`
      : `⚠ Post läuft in ${remainingHours.toFixed(0)}h ab`;
  }
  // Warn if post has unusually many votes — may cause node rejection on broadcast
  if (eligible && activeVotesCount > HIGH_VOTE_WARN_THRESHOLD) {
    const extra = `⚠ ${activeVotesCount} bestehende Votes — Node-Ablehnung möglich`;
    warning = warning ? `${warning} · ${extra}` : extra;
  }

  const pendingPayoutSbd = parseFloat(
    (post.pending_payout_value ?? "0 SBD").split(" ")[0]
  ) || 0;

  return {
    author:   post.author,
    permlink: post.permlink,
    title:    post.title || `${post.author}/${post.permlink}`,
    ageMinutes, remainingHours, postScore, pendingPayoutSbd,
    alreadyVoted, isSelfPost, eligible, warning,
    activeVotesCount, community,
  };
}
