// ── Vote-DNA constants & strategy types ──────────────────────────────────
// Extracted from App.tsx — shared types and constants for strategy management

import type { CurationProfile } from "../api";

export const dnaEmoji: Record<string, string> = {
  "Self-Focused Voter":      "🔴",
  "Loyal Inner Circle":      "🟣",
  "Loyal Community Curator": "🟦",
  "Broad Explorer":          "🟢",
  "Strategic Weight Voter":  "🟡",
  "High-Frequency Curator":  "🟠",
  "Niche Specialist":        "🟤",
  "Regular Curator":         "⚪",
};

export type StrategyCategory = "immer_voten" | "lieblingsautor" | "bevorzugt" | "normal" | "niedrig" | "ignorieren";

export const categoryLabel: Record<StrategyCategory, string> = {
  immer_voten:    "🔥 Immer voten",
  lieblingsautor: "⭐ Lieblingsautor",
  bevorzugt:      "🟦 Bevorzugt",
  normal:         "⚪ Normal",
  niedrig:        "⬇ Niedrige Priorität",
  ignorieren:     "🚫 Ignorieren",
};

export const categoryColor: Record<StrategyCategory, string> = {
  immer_voten:    "#ff6b35",
  lieblingsautor: "#d97706",
  bevorzugt:      "#2563eb",
  normal:         "#16a34a",
  niedrig:        "#607078",
  ignorieren:     "#dc2626",
};

const PRIORITY_MULTIPLIER: Record<StrategyCategory, number> = {
  immer_voten:    4.0,
  lieblingsautor: 2.5,
  bevorzugt:      1.5,
  normal:         1.0,
  niedrig:        0.4,
  ignorieren:     0,
};

export interface StrategyRule {
  username: string;
  category: StrategyCategory;
  maxWeightPct: number;
  minWeightPct: number;
  enabled: boolean;
  source: string;
  sharePct: number;
  voteCount: number;
  avgWeightPct: number;
  lastVoteDaysAgo: number;
  selectionReasons: string[];
  manuallyModified: boolean;
}

// ── Category-based meaningful vote weights ──────────────────────────────────
// Quality over quantity: fewer, stronger votes instead of many dust votes.
// The daily budget (2000 BPS = 20%/day) limits how often these can be used.

const CATEGORY_TARGET_BPS: Record<StrategyCategory, number> = {
  immer_voten:    10_000,  // 100% — always maximum
  lieblingsautor:  7_500,  // 75%
  bevorzugt:       3_000,  // 30%
  normal:          1_500,  // 15%
  niedrig:         1_000,  // 10%
  ignorieren:          0,
};

// Below these minimums: skip entirely (no dust votes)
const CATEGORY_MIN_BPS: Record<StrategyCategory, number> = {
  immer_voten:    5_000,  // 50%
  lieblingsautor: 3_000,  // 30%
  bevorzugt:      1_500,  // 15%
  normal:         1_000,  // 10%
  niedrig:          500,  //  5%
  ignorieren:         0,
};

// Minimum dust threshold — votes below this are worthless and skipped
const DUST_THRESHOLD_BPS = 1_000; // 10%

export function computeDynamicWeights(
  authors: Array<{ username: string; category: StrategyCategory }>,
  _dailyBudgetBps: number  // kept for API compat, not used in new model
): Map<string, number> {
  // Use category-based fixed targets — no proportional dilution across all authors
  return new Map(
    authors
      .filter(a => a.category !== "ignorieren")
      .map(a => [a.username, CATEGORY_TARGET_BPS[a.category] ?? DUST_THRESHOLD_BPS])
  );
}

export function generateStrategyFromProfile(profile: CurationProfile): StrategyRule[] {
  const self = profile.username.toLowerCase();

  const categorized: Array<typeof profile.topAuthors[0] & { category: StrategyCategory }> =
    profile.topAuthors.map((author, idx) => {
      const isSelf = author.username.toLowerCase() === self;
      let category: StrategyCategory;
      if (isSelf)        category = "ignorieren";
      else if (idx < 2)  category = "lieblingsautor";
      else if (idx < 10) category = "bevorzugt";
      else if (idx < 25) category = "normal";
      else               category = "niedrig";
      return { ...author, category };
    });

  return categorized.map(author => {
    const targetBps  = CATEGORY_TARGET_BPS[author.category] ?? 0;
    const minBps     = CATEGORY_MIN_BPS[author.category]    ?? 0;
    const maxWeightPct = Math.round(targetBps / 100 * 10) / 10;
    const minWeightPct = Math.round(minBps    / 100 * 10) / 10;

    return {
      username:         author.username,
      category:         author.category,
      maxWeightPct,
      minWeightPct,
      enabled:          author.category !== "ignorieren",
      source:           "Vote-DNA",
      sharePct:         author.sharePct,
      voteCount:        author.voteCount,
      avgWeightPct:     author.avgWeightPct,
      lastVoteDaysAgo:  author.lastVoteDaysAgo,
      selectionReasons: author.selectionReasons,
      manuallyModified: false,
    };
  });
}

// Suppress unused variable warning for PRIORITY_MULTIPLIER — kept for reference
void PRIORITY_MULTIPLIER;
