import type { ChangelogEntry, KnownIssue } from "@votebroker/domain";

/**
 * VoteBroker Changelog — edit this file to add new entries.
 *
 * Each entry has:
 *   date:                  "YYYY-MM-DD" (UTC)
 *   category:              feature | improvement | bugfix | infra | milestone | known_issue | roadmap | status
 *   title:                 Short name shown in bold
 *   description:           One-sentence explanation
 *   status?:               live | beta | preview | deprecated | offline
 *   component?:            auth | dna | voting | billing | infra | ui
 *   promotedToDescription?: true = include in static "Live Features" section once stable
 *
 * Keep newest entries first within each date.
 */
export const changelogEntries: ChangelogEntry[] = [

  // ── 2026-05-31 ────────────────────────────────────────────────────────────
  {
    date: "2026-05-31",
    category: "feature",
    title: "Vote-DNA Analysis",
    description: "Analyzes the last 500 blockchain votes and generates a personal curation profile — top authors, activity hours, vote weight pattern, DNA label, and Power-Stable weight recommendations.",
    status: "beta",
    component: "dna",
    promotedToDescription: false
  },
  {
    date: "2026-05-31",
    category: "feature",
    title: "Daily Fee Posts",
    description: "VoteBroker automatically publishes a daily update post (@votebroker/daily-fees-YYYY-MM-DD) for transparent fee settlement and development news.",
    status: "live",
    component: "billing",
    promotedToDescription: true
  },
  {
    date: "2026-05-31",
    category: "feature",
    title: "Live Vote-Value Calculation",
    description: "Vote values are calculated using the Steem reward fund and witness price feeds — accurate to ±3% and validated against SteemWorld.",
    status: "live",
    component: "voting",
    promotedToDescription: true
  },
  {
    date: "2026-05-31",
    category: "feature",
    title: "OAuth Login via SteemLogin",
    description: "Users authenticate with their Steem posting key through SteemLogin (steemlogin.com). No private keys are stored by VoteBroker.",
    status: "live",
    component: "auth",
    promotedToDescription: true
  },
  {
    date: "2026-05-31",
    category: "feature",
    title: "Posting Authority & Vote Execution",
    description: "Users grant @votebroker posting authority once. VoteBroker can then execute server-side votes on behalf of the user.",
    status: "live",
    component: "auth",
    promotedToDescription: true
  },
  {
    date: "2026-05-31",
    category: "improvement",
    title: "Tab-based Dashboard UI",
    description: "The dashboard is now organized into tabs: Vote-DNA (default after login), Dashboard (vote form), Community, and Settings.",
    status: "live",
    component: "ui",
    promotedToDescription: false
  },
  {
    date: "2026-05-31",
    category: "bugfix",
    title: "OAuth Redirect Loop Resolved",
    description: "Switching scope from offline,vote to login eliminates the infinite import→authorize→login loop in SteemLogin's web mode.",
    component: "auth"
  },
  {
    date: "2026-05-31",
    category: "bugfix",
    title: "Vote-Value 27× Calculation Error Fixed",
    description: "The vote value formula was missing division by max_vote_denom (50). The corrected formula uses reward fund + witness price feeds and matches SteemWorld.",
    component: "voting"
  },
  {
    date: "2026-05-31",
    category: "milestone",
    title: "First Live Vote on Daily Fee Post",
    description: "@jan-philippvieth cast the first vote on @votebroker/daily-fees-2026-05-31. End-to-end flow from OAuth login to blockchain vote confirmed working.",
    status: "live"
  },
  {
    date: "2026-05-31",
    category: "infra",
    title: "Production Deploy on Ubuntu VPS",
    description: "Full stack deployed via Docker Compose: Fastify API + React/Vite frontend + Caddy HTTPS reverse proxy with automatic Let's Encrypt certificates.",
    status: "live",
    component: "infra"
  }
];

/**
 * Persistent known limitations.
 * Set state: "resolved" to remove from the post without deleting the record.
 * State: planned | in_progress | monitoring | resolved
 */
export const knownIssues: KnownIssue[] = [
  {
    id: "invoice-persistence",
    title: "Invoice Persistence (RAM only)",
    description: "Fee invoices are stored in memory and lost on server restart. SQLite or file-based persistence is planned.",
    state: "planned",
    component: "billing",
    addedDate: "2026-05-31"
  },
  {
    id: "dashboard-demo-data",
    title: "Dashboard Demo Data",
    description: "The Curated Value, Fee Coverage, and chart sections still show placeholder data. Real data requires a persistent vote log.",
    state: "planned",
    component: "ui",
    addedDate: "2026-05-31"
  }
];
