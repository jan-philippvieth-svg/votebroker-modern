import { getDb } from "../db/index.js";
import { todayString, yesterdayString, utcOffsetMinutes, DEFAULT_TIMEZONE, startOfLocalDay, localDateString } from "../utils/timezone.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GrowthDataPoint {
  day:        string;  // "YYYY-MM-DD"
  votes:      number;  // votes cast on this day
  cumVotes:   number;  // running total
  newAuthors: number;  // unique authors first voted on this day
  cumAuthors: number;  // running total of unique authors ever supported
}

export interface GrowthSummary {
  totalVotes:         number;
  totalUniqueAuthors: number;
  activeDays:         number;   // days with at least one vote
  currentStreak:      number;   // consecutive days ending today or yesterday
  longestStreak:      number;   // all-time longest consecutive-day run
  firstVoteAt:        string | null;
  lastVoteAt:         string | null;
}

export interface GrowthData {
  period:     "30d" | "90d" | "all";
  dataPoints: GrowthDataPoint[];
  summary:    GrowthSummary;
}

// ── Internal row types ────────────────────────────────────────────────────────

interface VoteRow   { day: string; votes: number }
interface AuthorRow { author: string; first_day: string }
interface MetaRow   { total_votes: number; first_vote: string | null; last_vote: string | null }
interface DayRow    { day: string }

// ── Service ───────────────────────────────────────────────────────────────────

export function getGrowthData(username: string, period: "30d" | "90d" | "all", timezone: string = DEFAULT_TIMEZONE): GrowthData {
  const db    = getDb();
  const today  = todayString(timezone);
  const offsetMin = utcOffsetMinutes(timezone);

  const todayStartMs = startOfLocalDay(new Date(), timezone).getTime();
  const cutoff: Record<string, string> = {
    "30d": localDateString(new Date(todayStartMs -  29 * 86_400_000), timezone),
    "90d": localDateString(new Date(todayStartMs -  89 * 86_400_000), timezone),
    "all": "2000-01-01",
  };
  const since = cutoff[period];

  // ── All-time first-vote date per author ───────────────────────────────────
  // (needed to correctly split "new authors before period" from "new in period")
  const authorRows = db.prepare(`
    SELECT author, DATE(MIN(created_at)) AS first_day
    FROM   audit_events
    WHERE  type = 'vote_broadcast_success' AND username = ?
    GROUP  BY author
  `).all(username) as AuthorRow[];

  // ── Daily vote counts within the period (Europe/Berlin calendar day) ────────
  // offsetMin is the current Berlin UTC offset (60 in winter, 120 in summer).
  // Applying it via SQLite datetime() shifts UTC timestamps to local time before
  // extracting the date — correct for all historical votes regardless of DST.
  const dailyVoteRows = db.prepare(`
    SELECT DATE(datetime(created_at, '+${offsetMin} minutes')) AS day, COUNT(*) AS votes
    FROM   audit_events
    WHERE  type = 'vote_broadcast_success'
      AND  username = ?
      AND  DATE(datetime(created_at, '+${offsetMin} minutes')) >= ?
    GROUP  BY day
    ORDER  BY day ASC
  `).all(username, since) as VoteRow[];

  // ── Overall metadata ──────────────────────────────────────────────────────
  const meta = db.prepare(`
    SELECT
      COUNT(*)           AS total_votes,
      MIN(DATE(created_at)) AS first_vote,
      MAX(DATE(created_at)) AS last_vote
    FROM audit_events
    WHERE type = 'vote_broadcast_success' AND username = ?
  `).get(username) as MetaRow;

  if (!meta || !meta.total_votes) {
    return {
      period,
      dataPoints: [],
      summary: {
        totalVotes: 0, totalUniqueAuthors: 0, activeDays: 0,
        currentStreak: 0, longestStreak: 0, firstVoteAt: null, lastVoteAt: null,
      },
    };
  }

  // ── Build lookup maps ─────────────────────────────────────────────────────

  const votesByDay      = new Map<string, number>(dailyVoteRows.map(r => [r.day, r.votes]));
  const newAuthorsByDay = new Map<string, number>();

  for (const { first_day } of authorRows) {
    if (first_day >= since) {
      newAuthorsByDay.set(first_day, (newAuthorsByDay.get(first_day) ?? 0) + 1);
    }
  }

  // Authors whose first vote happened before this period started
  const baselineCumAuthors = authorRows.filter(a => a.first_day < since).length;

  // ── Generate all days in range ────────────────────────────────────────────

  const startDay = period === "all" && meta.first_vote ? meta.first_vote : since;
  const days: string[] = [];
  const cursor = new Date(startDay + "T00:00:00Z");
  const endDay = new Date(today + "T00:00:00Z");

  while (cursor <= endDay) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // ── Build data points ─────────────────────────────────────────────────────

  let runVotes   = 0;
  let runAuthors = baselineCumAuthors;

  const dataPoints: GrowthDataPoint[] = days.map(day => {
    const votes      = votesByDay.get(day)      ?? 0;
    const newAuthors = newAuthorsByDay.get(day)  ?? 0;
    runVotes   += votes;
    runAuthors += newAuthors;
    return { day, votes, cumVotes: runVotes, newAuthors, cumAuthors: runAuthors };
  });

  // ── Streak calculation from all-time active days ──────────────────────────

  const activeDaysSorted = (db.prepare(`
    SELECT DISTINCT DATE(datetime(created_at, '+${offsetMin} minutes')) AS day
    FROM   audit_events
    WHERE  type = 'vote_broadcast_success' AND username = ?
    ORDER  BY day ASC
  `).all(username) as DayRow[]).map(r => r.day);

  let longestStreak = activeDaysSorted.length > 0 ? 1 : 0;
  let tempStreak    = 1;

  for (let i = 1; i < activeDaysSorted.length; i++) {
    const diff = (
      new Date(activeDaysSorted[i] + "T00:00:00Z").getTime() -
      new Date(activeDaysSorted[i - 1] + "T00:00:00Z").getTime()
    ) / 86_400_000;
    if (diff === 1) {
      tempStreak++;
      longestStreak = Math.max(longestStreak, tempStreak);
    } else {
      tempStreak = 1;
    }
  }

  // Current streak: consecutive days ending today or yesterday
  let currentStreak = 0;
  if (activeDaysSorted.length > 0) {
    const lastDay   = activeDaysSorted[activeDaysSorted.length - 1];
    const yesterday = yesterdayString(timezone);
    if (lastDay === today || lastDay === yesterday) {
      currentStreak = 1;
      for (let i = activeDaysSorted.length - 2; i >= 0; i--) {
        const diff = (
          new Date(activeDaysSorted[i + 1] + "T00:00:00Z").getTime() -
          new Date(activeDaysSorted[i] + "T00:00:00Z").getTime()
        ) / 86_400_000;
        if (diff === 1) currentStreak++;
        else break;
      }
    }
  }

  return {
    period,
    dataPoints,
    summary: {
      totalVotes:         meta.total_votes ?? 0,
      totalUniqueAuthors: authorRows.length,
      activeDays:         activeDaysSorted.length,
      currentStreak,
      longestStreak,
      firstVoteAt:        meta.first_vote ?? null,
      lastVoteAt:         meta.last_vote  ?? null,
    },
  };
}
