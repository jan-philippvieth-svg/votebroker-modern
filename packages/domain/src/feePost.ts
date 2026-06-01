import {
  collectPromotedFeatures,
  formatChangelogSection,
  formatKnownIssues,
  formatSystemStatus,
  type ChangelogEntry,
  type KnownIssue,
  type SystemStatus
} from "./changelog.js";

export function dailyFeePostPermlink(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `daily-fees-${y}-${m}-${d}`;
}

export function buildDailyFeePostBody(params: {
  date: Date;
  newUsers?: string[];
  changelog?: ChangelogEntry[];
  knownIssues?: KnownIssue[];
  systemStatus?: SystemStatus;
}): { title: string; body: string } {
  const dateStr = dailyFeePostPermlink(params.date).replace("daily-fees-", "");
  const title   = `VoteBroker Daily Update — ${dateStr}`;
  const parts: string[] = [];

  // ── 1. Daily News (only if entries exist for today) ────────────────────────
  const newsSection = params.changelog
    ? formatChangelogSection(params.changelog, dateStr)
    : "";
  if (newsSection) parts.push(newsSection);

  // ── 2. Welcome new users (only if present) ─────────────────────────────────
  if (params.newUsers && params.newUsers.length > 0) {
    const mentions = params.newUsers.map(u => `@${u}`).join(", ");
    parts.push(
      `### 👋 Welcome to VoteBroker!\n\nWe're happy to welcome new users today: ${mentions}\n\nYou can test VoteBroker right away — request a vote quote, review the calculated weight, and decide whether to execute. No private keys are ever stored. You can revoke access at any time.\n`
    );
  }

  // ── 3. Static product description (always) ─────────────────────────────────
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

  // ── 4. System Status (always) ──────────────────────────────────────────────
  if (params.systemStatus) {
    parts.push(`---\n\n${formatSystemStatus(params.systemStatus)}`);
  }

  // ── 5. Known Limitations (always if any unresolved) ────────────────────────
  if (params.knownIssues && params.knownIssues.length > 0) {
    const issueSection = formatKnownIssues(params.knownIssues);
    if (issueSection) parts.push(issueSection);
  }

  // ── 6. Fee Settlement (always) ─────────────────────────────────────────────
  parts.push(`---

## 💰 Fee Settlement — ${dateStr}

Votes on this post are used by VoteBroker users to settle open service fees for ${dateStr}. The fee is calculated as a small percentage of the vote value moved and settled via a weighted upvote — transparent and on-chain.

This post remains permanently on-chain as a public settlement record.

**Billing tiers:**
- 🆓 **Free** — vote value ≤ $0.25: no fee, no invoice
- 🎁 **Donation** — vote value ≤ $1.00 or fee weight would be disproportionate: voluntary support only
- 💳 **Billable** — fee settled via a weighted vote on this post

---

*Posted automatically by VoteBroker — a community support and curation management system for Steem.*`);

  return { title, body: parts.join("\n\n") };
}
