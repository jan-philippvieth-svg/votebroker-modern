import {
  collectPromotedFeatures,
  formatChangelogSection,
  formatKnownIssues,
  formatSystemStatus,
  type ChangelogEntry,
  type KnownIssue,
  type SystemStatus
} from "./changelog.js";

// ── Fee Settlement Post ───────────────────────────────────────────────────────
// Permlink: daily-fees-YYYY-MM-DD
// Purpose:  daily settlement record — users vote on this to pay service fees
// Content:  focused on settlement transparency, system status, brief footer
// NOT:      product marketing, changelog, new-user welcome (→ use Daily Update)

export function dailyFeePostPermlink(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `daily-fees-${y}-${m}-${d}`;
}

export function buildDailyFeePostBody(params: {
  date: Date;
  newUsers?: string[];       // reserved — not shown in settlement post
  changelog?: ChangelogEntry[];  // reserved — not shown in settlement post
  knownIssues?: KnownIssue[];
  systemStatus?: SystemStatus;
}): { title: string; body: string } {
  const dateStr = dailyFeePostPermlink(params.date).replace("daily-fees-", "");
  const title   = `VoteBroker Fee Settlement — ${dateStr}`;
  const parts: string[] = [];

  // ── 1. Fee Settlement (PRIMARY — this is the whole point of the post) ─────
  parts.push(`## 💰 Fee Settlement — ${dateStr}

Votes on this post are used by VoteBroker users to settle open service fees for **${dateStr}**.

The fee is calculated as a small percentage of the vote value moved and settled via a weighted upvote on this post — transparent, on-chain, and permanently verifiable.

**Billing tiers:**
| Tier | Condition | Settlement |
|------|-----------|-----------|
| 🆓 Free | vote value ≤ $0.25 | no fee, no invoice |
| 🎁 Donation | vote value ≤ $1.00 or weight would be disproportionate | voluntary support only |
| 💳 Billable | standard curation support | weighted upvote on this post |

Each settlement vote is calculated from the actual vote value moved — not a fixed amount. The exact weight is shown to the user before they confirm.`);

  // ── 2. System Status (proves the service ran today) ───────────────────────
  if (params.systemStatus) {
    parts.push(`---\n\n${formatSystemStatus(params.systemStatus)}`);
  }

  // ── 3. Known Limitations (only if unresolved issues exist) ───────────────
  if (params.knownIssues && params.knownIssues.length > 0) {
    const issueSection = formatKnownIssues(params.knownIssues);
    if (issueSection) parts.push(issueSection);
  }

  // ── 4. Footer ─────────────────────────────────────────────────────────────
  parts.push(`---

*VoteBroker is a community support and curation management system for the Steem blockchain. This post is published automatically each day as a transparent, on-chain fee settlement record.*

🌐 votebroker.org`);

  return { title, body: parts.join("\n\n") };
}

// ── Daily Update Post ─────────────────────────────────────────────────────────
// Permlink: daily-update-YYYY-MM-DD
// Purpose:  product news, changelog, dev log, new-user welcome, community content
// NOT:      fee settlement (→ use Fee Settlement Post)

export function dailyUpdatePermlink(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `daily-update-${y}-${m}-${d}`;
}

export function buildDailyUpdateBody(params: {
  date: Date;
  newUsers?: string[];
  changelog?: ChangelogEntry[];
  knownIssues?: KnownIssue[];
  systemStatus?: SystemStatus;
}): { title: string; body: string } {
  const dateStr = params.date.toISOString().slice(0, 10);
  const title   = `VoteBroker Daily Update — ${dateStr}`;
  const parts: string[] = [];

  // ── 1. Changelog / News ───────────────────────────────────────────────────
  const newsSection = params.changelog
    ? formatChangelogSection(params.changelog, dateStr)
    : "";
  if (newsSection) parts.push(newsSection);

  // ── 2. Welcome new users ──────────────────────────────────────────────────
  if (params.newUsers && params.newUsers.length > 0) {
    const mentions = params.newUsers.map(u => `@${u}`).join(", ");
    parts.push(
      `### 👋 Welcome to VoteBroker!\n\nWe're happy to welcome new users today: ${mentions}\n\nYou can test VoteBroker right away — request a vote quote, review the calculated weight, and decide whether to execute. No private keys are ever stored. You can revoke access at any time.\n`
    );
  }

  // ── 3. About VoteBroker ───────────────────────────────────────────────────
  const promotedFeatures = params.changelog ? collectPromotedFeatures(params.changelog) : [];
  const liveFeatureList  = promotedFeatures.length > 0
    ? `\n\n**Live Features:**\n${promotedFeatures.map(f => `- ${f.title} — ${f.description}`).join("\n")}`
    : "";

  parts.push(`---

## ℹ️ About VoteBroker

VoteBroker is a **community support and curation management system** for the Steem blockchain.

The goal is to help curators support as many relevant authors as possible — sustainably, with meaningful vote weights, and without depleting their Voting Power.

**What VoteBroker is not:**
- Not a bot that maximizes curation rewards
- Not a tool for extracting the last fraction of STEEM earnings
- Not an autonomous system that decides for you

**What VoteBroker is:**
- A system for people who want to actively curate and support Steem content
- A way to manage your personal author strategy: Favorites, Preferred, Normal, Low-priority
- A tool that answers: "How do I support 50 authors sustainably — without burning my VP?"

**How it works:**
- Build your author strategy — tell VoteBroker who matters to you
- VoteBroker scans for new posts from those authors
- A vote plan is generated that distributes support across as many authors as possible, within your VP limits
- Every vote requires your explicit consent — no black box, no autonomous decisions

**Key principle:** Voting Power is a limited resource. VoteBroker helps you use it as effectively as possible for community support — not to extract the maximum reward per vote.

**Technical:** Votes are executed via SteemConnect (Posting Authority delegation). No private keys are ever stored or transmitted.${liveFeatureList}

🌐 [votebroker.org](https://votebroker.org)`);

  // ── 4. System Status ──────────────────────────────────────────────────────
  if (params.systemStatus) {
    parts.push(`---\n\n${formatSystemStatus(params.systemStatus)}`);
  }

  // ── 5. Known Issues ───────────────────────────────────────────────────────
  if (params.knownIssues && params.knownIssues.length > 0) {
    const issueSection = formatKnownIssues(params.knownIssues);
    if (issueSection) parts.push(issueSection);
  }

  parts.push(`---

*Posted automatically by VoteBroker — a community support and curation management system for Steem.*`);

  return { title, body: parts.join("\n\n") };
}
