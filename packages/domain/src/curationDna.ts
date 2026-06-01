export interface VoteRecord {
  author: string;
  permlink: string;
  weight: number;    // -10000 to 10000 (BPS)
  timestamp: string; // ISO UTC e.g. "2026-05-31T12:00:00"
}

export interface AuthorStats {
  username: string;
  voteCount: number;
  sharePct: number;
  avgWeightPct: number;
  compositeScore: number;
  lastVoteDaysAgo: number;
  selectionReasons: string[];
}

export interface HourStats {
  hour: number;       // 0-23 UTC
  voteCount: number;
  sharePct: number;
}

export interface SuggestedAuthorWeight {
  username: string;
  suggestedWeightBps: number;
  suggestedWeightPct: number;
  basedOnSharePct: number;
}

export interface CurationProfile {
  username: string;
  votesAnalyzed: number;
  periodDays: number;
  votesPerDay: number;
  uniqueAuthors: number;
  selfVotePct: number;
  avgWeightPct: number;
  fullWeightPct: number;
  topAuthors: AuthorStats[];
  peakHoursUtc: HourStats[];
  dnaLabel: string;
  dnaDescription: string;
  powerStable: {
    maxAvgWeightBps: number;
    maxAvgWeightPct: number;
    relevantAuthors: number;
    suggestedTopWeights: SuggestedAuthorWeight[];
  };
}

function counter<T>(items: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const item of items) m.set(item, (m.get(item) ?? 0) + 1);
  return m;
}

function topN<T>(m: Map<T, number>, n: number): [T, number][] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function classifyDna(params: {
  selfVotePct: number;
  uniqueAuthors: number;
  top3SharePct: number;
  top5SharePct: number;
  fullWeightPct: number;
  votesPerDay: number;
}): { label: string; description: string } {
  const { selfVotePct, uniqueAuthors, top3SharePct, top5SharePct, fullWeightPct, votesPerDay } = params;

  if (selfVotePct > 25) {
    return {
      label: "Self-Focused Voter",
      description: "A significant portion of votes go to own posts. Consider broadening to support more community members."
    };
  }
  if (top3SharePct > 50 && fullWeightPct > 85) {
    return {
      label: "Loyal Inner Circle",
      description: "Strong loyalty to a small group of authors with consistent full-weight votes. Deep community ties."
    };
  }
  if (top5SharePct > 35 && fullWeightPct > 85) {
    return {
      label: "Loyal Community Curator",
      description: "Regular support for a core set of authors with consistent full-weight votes. Reliable and predictable curation."
    };
  }
  if (uniqueAuthors > 60 && top5SharePct < 15) {
    return {
      label: "Broad Explorer",
      description: "Wide discovery across many authors and topics. High diversity, low concentration per author."
    };
  }
  if (fullWeightPct < 50) {
    return {
      label: "Strategic Weight Voter",
      description: "Varied vote weights suggest deliberate strength calibration per post or author."
    };
  }
  if (votesPerDay > 20) {
    return {
      label: "High-Frequency Curator",
      description: "Active curator with high daily vote frequency. Large curation footprint on the blockchain."
    };
  }
  if (uniqueAuthors < 20 && top3SharePct > 40) {
    return {
      label: "Niche Specialist",
      description: "Focused on a small niche of authors. Concentrated support with expert-level familiarity."
    };
  }
  return {
    label: "Regular Curator",
    description: "Balanced curation pattern across a moderate author set with consistent engagement."
  };
}

function computeSelectionReasons(params: {
  voteCount: number;
  sharePct: number;
  avgWeightPct: number;
  lastVoteDaysAgo: number;
  periodDays: number;
  totalAuthors: number;
}): string[] {
  const { voteCount, sharePct, avgWeightPct, lastVoteDaysAgo, periodDays, totalAuthors } = params;
  const reasons: string[] = [];

  if (voteCount >= 10) reasons.push("Sehr hohe Aktivität");
  else if (voteCount >= 5) reasons.push("Regelmäßige Aktivität");

  if (avgWeightPct >= 80) reasons.push("Konstant hohe Vote-Gewichte");
  else if (avgWeightPct >= 50) reasons.push("Überdurchschnittliches Gewicht");
  else if (avgWeightPct >= 30) reasons.push("Mittleres Conviction-Level");

  if (sharePct >= 10) reasons.push("Sehr hoher Anteil aller Votes");
  else if (sharePct >= 5) reasons.push("Hoher Anteil aller Votes");

  if (lastVoteDaysAgo <= 2) reasons.push("Kürzlich gevoted");
  else if (lastVoteDaysAgo <= 7) reasons.push("Aktuelle Voting-Beziehung");

  // Long-term relationship: voted at least once per week over the period
  if (periodDays >= 21 && voteCount >= Math.round(periodDays / 7)) {
    reasons.push("Langfristige Voting-Beziehung");
  }

  // Strategic: high weight conviction even with fewer votes
  if (avgWeightPct >= 70 && voteCount >= 3) reasons.push("Strategisch wichtiger Autor");

  // Top author in community
  if (sharePct >= 5 && totalAuthors > 20) reasons.push("Top-Autor in deiner Community");

  return reasons;
}

export function analyzeCurationHistory(params: {
  username: string;
  votes: VoteRecord[];
  accountVotingPowerBps?: number;
}): CurationProfile {
  const { username, votes } = params;
  const selfVotes = username.toLowerCase();

  if (votes.length === 0) {
    return {
      username,
      votesAnalyzed: 0,
      periodDays: 0,
      votesPerDay: 0,
      uniqueAuthors: 0,
      selfVotePct: 0,
      avgWeightPct: 0,
      fullWeightPct: 0,
      topAuthors: [],
      peakHoursUtc: [],
      dnaLabel: "No History",
      dnaDescription: "No votes found in the analyzed period.",
      powerStable: { maxAvgWeightBps: 0, maxAvgWeightPct: 0, relevantAuthors: 0, suggestedTopWeights: [] }
    };
  }

  // Period
  const timestamps = votes.map(v => v.timestamp).sort();
  const tsFirst = new Date(timestamps[0]);
  const tsLast  = new Date(timestamps[timestamps.length - 1]);
  const periodDays = Math.max(1, Math.round((tsLast.getTime() - tsFirst.getTime()) / 86_400_000));

  // Author distribution (upvotes only)
  const upvotes = votes.filter(v => v.weight > 0);
  const authorCounts = counter(upvotes.map(v => v.author));
  const totalUpvotes = upvotes.length;

  const selfCount = authorCounts.get(selfVotes) ?? 0;
  const selfVotePct = totalUpvotes > 0 ? Math.round(selfCount / totalUpvotes * 1000) / 10 : 0;

  // Per-author weight sums + last vote timestamps
  const authorWeightSum = new Map<string, number>();
  const authorLastMs = new Map<string, number>();
  for (const vote of upvotes) {
    authorWeightSum.set(vote.author, (authorWeightSum.get(vote.author) ?? 0) + vote.weight);
    const ms = new Date(vote.timestamp).getTime();
    const prev = authorLastMs.get(vote.author) ?? 0;
    if (ms > prev) authorLastMs.set(vote.author, ms);
  }

  const nowMs = Date.now();
  const totalAuthors = authorCounts.size;

  const topAuthorsRaw = topN(authorCounts, 50);
  const topAuthors: AuthorStats[] = topAuthorsRaw.map(([u, c]) => {
    const wSum = authorWeightSum.get(u) ?? 0;
    const avgWeightBps = c > 0 ? wSum / c : 0;
    const avgWeightPct = Math.round(avgWeightBps / 100 * 10) / 10;

    const lastMs = authorLastMs.get(u) ?? nowMs;
    const lastVoteDaysAgo = Math.round((nowMs - lastMs) / 86_400_000);

    // Composite: count × avgWeight × recency (half-life 30 days)
    const recency = Math.max(0.1, Math.exp(-lastVoteDaysAgo / 30));
    const compositeScore = Math.round(c * avgWeightPct * recency * 10) / 10;

    const selectionReasons = computeSelectionReasons({
      voteCount: c,
      sharePct: Math.round(c / totalUpvotes * 1000) / 10,
      avgWeightPct,
      lastVoteDaysAgo,
      periodDays,
      totalAuthors,
    });

    return {
      username: u,
      voteCount: c,
      sharePct: Math.round(c / totalUpvotes * 1000) / 10,
      avgWeightPct,
      compositeScore,
      lastVoteDaysAgo,
      selectionReasons,
    };
  }).sort((a, b) => b.compositeScore - a.compositeScore);

  // Weight stats
  const nonZeroWeights = votes.filter(v => v.weight !== 0).map(v => Math.abs(v.weight));
  const avgWeightBps = nonZeroWeights.length > 0
    ? nonZeroWeights.reduce((a, b) => a + b, 0) / nonZeroWeights.length
    : 0;
  const fullWeightCount = nonZeroWeights.filter(w => w === 10_000).length;

  // Hourly activity
  const hourCounts = counter(votes.map(v => new Date(v.timestamp).getUTCHours()));
  const peakHoursUtc: HourStats[] = topN(hourCounts, 8)
    .sort((a, b) => a[0] - b[0])
    .map(([h, c]) => ({
      hour: h,
      voteCount: c,
      sharePct: Math.round(c / votes.length * 1000) / 10
    }));

  // Top-N concentration
  const top3Share = topN(authorCounts, 3).reduce((s, [, c]) => s + c, 0) / totalUpvotes * 100;
  const top5Share = topN(authorCounts, 5).reduce((s, [, c]) => s + c, 0) / totalUpvotes * 100;

  const { label, description } = classifyDna({
    selfVotePct,
    uniqueAuthors: authorCounts.size,
    top3SharePct: top3Share,
    top5SharePct: top5Share,
    fullWeightPct: nonZeroWeights.length > 0 ? fullWeightCount / nonZeroWeights.length * 100 : 0,
    votesPerDay: votes.length / periodDays
  });

  const votesPerDay = Math.round(votes.length / periodDays * 10) / 10;
  const dailyBudgetBps = 2_000;
  const plannedVotesPerDay = Math.max(1, Math.round(votesPerDay));
  const maxAvgWeightBps = Math.floor(dailyBudgetBps / plannedVotesPerDay);
  const relevantAuthors = [...authorCounts.entries()].filter(([, c]) => c >= 3).length;

  const top10 = topN(authorCounts, 10);
  const top10Total = top10.reduce((s, [, c]) => s + c, 0);
  const suggestedTopWeights: SuggestedAuthorWeight[] = top10.map(([u, c]) => {
    const share = c / top10Total;
    const weightBps = Math.max(1, Math.round(maxAvgWeightBps * share * 10));
    return {
      username: u,
      suggestedWeightBps: weightBps,
      suggestedWeightPct: Math.round(weightBps / 100 * 10) / 10,
      basedOnSharePct: Math.round(c / totalUpvotes * 1000) / 10
    };
  });

  return {
    username,
    votesAnalyzed: votes.length,
    periodDays,
    votesPerDay,
    uniqueAuthors: authorCounts.size,
    selfVotePct,
    avgWeightPct: Math.round(avgWeightBps / 100 * 10) / 10,
    fullWeightPct: nonZeroWeights.length > 0
      ? Math.round(fullWeightCount / nonZeroWeights.length * 1000) / 10
      : 0,
    topAuthors,
    peakHoursUtc,
    dnaLabel: label,
    dnaDescription: description,
    powerStable: {
      maxAvgWeightBps,
      maxAvgWeightPct: Math.round(maxAvgWeightBps / 100 * 10) / 10,
      relevantAuthors,
      suggestedTopWeights
    }
  };
}
