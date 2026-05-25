import type { BasisPoints, VoteQuote, VoteQuoteRequest } from "./types.js";

export const MAX_BPS = 10_000;

export function clampBps(value: number): BasisPoints {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_BPS, Math.round(value)));
}

export function getAvailableFullVoteUsd(fullPowerVoteUsd: number, votingPowerBps: BasisPoints): number {
  if (fullPowerVoteUsd <= 0 || votingPowerBps <= 0) {
    return 0;
  }
  return fullPowerVoteUsd * (clampBps(votingPowerBps) / MAX_BPS);
}

export function quoteUsdVote(request: VoteQuoteRequest): VoteQuote {
  const warnings: string[] = [];
  const availableFullVoteUsd = getAvailableFullVoteUsd(
    request.account.fullPowerVoteUsd,
    request.account.votingPowerBps
  );

  if (request.desiredVoteUsd <= 0) {
    return {
      author: request.author,
      permlink: request.permlink,
      desiredVoteUsd: request.desiredVoteUsd,
      expectedVoteUsd: 0,
      voteWeightBps: 0,
      capped: false,
      warnings: ["Der gewuenschte USD-Wert muss groesser als 0 sein."]
    };
  }

  if (availableFullVoteUsd <= 0) {
    return {
      author: request.author,
      permlink: request.permlink,
      desiredVoteUsd: request.desiredVoteUsd,
      expectedVoteUsd: 0,
      voteWeightBps: 0,
      capped: true,
      warnings: ["Aktuell ist kein wirksamer Vote-Wert verfuegbar."]
    };
  }

  const rawWeight = (request.desiredVoteUsd / availableFullVoteUsd) * MAX_BPS;
  const voteWeightBps = clampBps(rawWeight);
  const expectedVoteUsd = roundUsd(availableFullVoteUsd * (voteWeightBps / MAX_BPS));
  const capped = rawWeight > MAX_BPS;

  if (capped) {
    warnings.push("Der Zielwert ist hoeher als der aktuell maximal moegliche Vote.");
  }

  return {
    author: request.author,
    permlink: request.permlink,
    desiredVoteUsd: roundUsd(request.desiredVoteUsd),
    expectedVoteUsd,
    voteWeightBps,
    capped,
    warnings
  };
}

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
