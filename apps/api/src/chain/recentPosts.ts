import { createSteemClient } from "./steemBroadcaster.js";

// Steem payout window: exactly 7 days after post creation
const PAYOUT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_AGE_MS       = 5 * 60 * 1000;   // 5 min curation minimum
const WARN_EXPIRY_H    = 24;              // warn when < 24h remaining

export interface PostOpportunity {
  author:         string;
  permlink:       string;
  title:          string;
  ageMinutes:     number;
  remainingHours: number;
  postScore:      number;
  alreadyVoted:   boolean;
  eligible:       boolean;
  warning:        string | null;
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

interface RawPost {
  author:        string;
  permlink:      string;
  title:         string;
  created:       string;
  active_votes?: Array<{ voter: string; weight: number }>;
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

    // Step 5: too new
    if (ageMs < MIN_AGE_MS) {
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

async function fetchRawPosts(author: string, limit: number): Promise<RawPost[] | null> {
  const client = createSteemClient();
  const db = client.database as unknown as {
    call(method: string, params: unknown[]): Promise<RawPost[]>
  };
  try {
    const posts = await db.call("get_discussions_by_blog", [{ tag: author, limit }]);
    return Array.isArray(posts) ? posts : null;
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
  const withinWindow   = ageMs >= MIN_AGE_MS && remainingMs > 0;
  const eligible       = !alreadyVoted && withinWindow;
  const postScore      = calcPostScore(ageMinutes, remainingHours);

  let warning: string | null = null;
  if (eligible && remainingHours > 0 && remainingHours < WARN_EXPIRY_H) {
    warning = remainingHours < 6
      ? `⚡ Nur noch ${remainingHours.toFixed(1)}h bis Auszahlung — letzte Chance`
      : `⚠ Post läuft in ${remainingHours.toFixed(0)}h ab`;
  }

  return {
    author:   post.author,
    permlink: post.permlink,
    title:    post.title || `${post.author}/${post.permlink}`,
    ageMinutes, remainingHours, postScore,
    alreadyVoted, eligible, warning,
  };
}
