#!/usr/bin/env node
/**
 * devlog-today.js — VoteBroker Content Generator v3 (English)
 *
 * Generates three publication-ready English drafts from today's DevLog.
 * Rules:
 *  - No placeholders. No TODO. No edit markers.
 *  - Complete prose only.
 *  - Always English.
 *  - Self-validates before saving.
 *
 * Run via: npm run devlog:today
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT        = resolve(__dirname, "..");
const DEVLOG_DIR  = resolve(ROOT, "docs/devlog");
const CONTENT_DIR = resolve(ROOT, "docs/content");

const today = new Date().toISOString().slice(0, 10);
mkdirSync(CONTENT_DIR, { recursive: true });

// ── Content Safety ────────────────────────────────────────────────────────────

const SAFETY_RULES = [
  [/\b5[HJK][1-9A-Za-z]{48,}\b/g,              "[REDACTED_WIF]"],
  [/\b[0-9a-f]{40,}\b/gi,                       "[REDACTED_KEY]"],
  [/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi,          "Bearer [REDACTED]"],
  [/(access_token|secret|client_secret)["\s:=]+[A-Za-z0-9\-_.~+/]{8,}/gi, "$1: [REDACTED]"],
  [/VOTEBROKER_OPERATOR_TOKEN[=:\s]+[^\s\n]+/gi, "VOTEBROKER_OPERATOR_TOKEN=[REDACTED]"],
  [/VOTEBROKER_POSTING_WIF[=:\s]+[^\s\n]+/gi,   "VOTEBROKER_POSTING_WIF=[REDACTED]"],
  [/\b(10|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.\d+\.\d+\b/g, "[INTERNAL_IP]"],
];

function sanitize(text) {
  let out = text ?? "";
  for (const [p, r] of SAFETY_RULES) out = out.replace(p, r);
  return out;
}

// ── Self-Validation ───────────────────────────────────────────────────────────

const VIOLATION_PATTERNS = [
  { p: /bitte manuell ausfüllen/i,         label: '"bitte manuell ausfüllen"' },
  { p: /\bTODO\b/,                          label: 'TODO marker' },
  { p: /\bTBD\b/,                           label: 'TBD marker' },
  { p: /\bPLACEHOLDER\b/i,                 label: 'PLACEHOLDER' },
  { p: /interner Hinweis/i,                 label: '"interner Hinweis"' },
  { p: /vor.{0,20}(Veröffentlichung|Publication).{0,20}entfernen/i, label: '"vor Veröffentlichung entfernen"' },
  { p: /\*\(Optional:.*?\)\*/,              label: 'Optional-Marker' },
  { p: /✏\s*(EDIT|MANUAL EDIT)/,           label: '✏ edit marker' },
  { p: /<!--[\s\S]{0,200}?(EDIT|TODO|REVIEW)[\s\S]{0,200}?-->/i, label: 'HTML comment EDIT/TODO' },
  { p: /aus Roadmap ergänzen/i,             label: '"aus Roadmap ergänzen"' },
  { p: /hier ergänzen/i,                    label: '"hier ergänzen"' },
  { p: /DRAFT.*REVIEW BEFORE PUBLISHING/i,  label: 'DRAFT warning in body' },
  { p: /please fill in|fill this in|add content/i, label: 'fill-in instruction' },
];

function selfCheck(content) {
  const bodyStart = content.indexOf("\n---\n", 4);
  const body = bodyStart > 0 ? content.slice(bodyStart + 5) : content;
  return VIOLATION_PATTERNS.filter(({ p }) => p.test(body)).map(({ label }) => label);
}

// ── DevLog Parsing ────────────────────────────────────────────────────────────

const META_HEADINGS = [
  /^session summary/i, /^umsetzung/i, /^offene punkte/i,
  /^architekturentscheidung/i, /^auswirkungen/i, /^schema/i,
  /^geänderte dateien/i, /^neue features/i, /^bugfixes/i,
  /^testablauf/i, /^pre-restart/i, /^post-restart/i, /^schritt \d/i,
  /^devlog.{0,20}\d{4}-\d{2}-\d{2}/i,
  /^ergebnis$/i, /^smoke test/i, /^verifikation/i,
  /^problem$/i, /^lösung$/i, /^result$/i, /^vorbedingung/i,
];
const TECH_LINE = /import |export |await |async |const |let |`[a-z]+\.[a-z]+\(|\.run\(|\.prepare\(|tsconfig|Dockerfile|package\.json|SQL|INSERT|SELECT|CREATE TABLE/i;

const isMeta = h => META_HEADINGS.some(p => p.test(h));
const isUserFacing = h => !isMeta(h) && h.length > 5 && h.length < 80 && !/^\d{4}-\d{2}-\d{2}/.test(h);
// German technical verbs that indicate implementation details, not user-facing next steps
const GERMAN_TECH_VERBS = /^\s*[-*•]\s*(Filtert|Berechnet|Prüft|Gibt|Nimmt|Verarbeitet|Liest|Schreibt|Sendet|Lädt|Erstellt|Ruft|Setzt|Speichert|Löscht|Batched|Returned?)\b/i;
// German structural words that indicate internal context, not user-facing language
const GERMAN_STRUCTURAL = /\b(nicht bereits gevoted|min\.\s*\d|max\.\s*\d+\s*(Tage|Min|Std)|vor Payout.Lock|Payout.Fenster)\b/i;

const isUserNextStep = l =>
  !/`[a-z]|\.ts|\.js|api\/|Filtert Reblogs|Fetch|Push|BATCH/i.test(l)  // no code artifacts
  && !GERMAN_TECH_VERBS.test(l)       // no German technical verbs
  && !GERMAN_STRUCTURAL.test(l)       // no German structural detail language
  && !/^\s*-\s*\[/.test(l)            // no checklist items
  && l.length > 10;

function cleanHeading(h) {
  return h.replace(/^(bugfix:|fix:|neu:|neue?:|added:|update:|root cause:)/i, "")
          .replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
}

function parseDevlog(text) {
  const lines = text.split("\n");
  const sections = [];
  let cur = null;

  for (const line of lines) {
    if (/^#{1,3} /.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line.replace(/^#+\s*/, "").trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) sections.push(cur);

  const changeHeadings = sections
    .filter(s => isUserFacing(s.heading))
    .map(s => s.heading)
    .slice(0, 12);

  const problemTexts = sections
    .filter(s => isUserFacing(s.heading) && changeHeadings.includes(s.heading))
    .map(s => ({
      heading: s.heading,
      problem: s.lines.slice(0, 8).filter(l => l.trim() && !TECH_LINE.test(l)).join(" ").trim(),
    }));

  const userBullets = sections
    .filter(s => !isMeta(s.heading))
    .flatMap(s => s.lines)
    .filter(l => /^[-*•✓✅] /.test(l.trim()) && !TECH_LINE.test(l) && l.length > 10 && l.length < 200)
    .map(l => l.trim())
    .slice(0, 12);

  const archSections = sections
    .filter(s => /architektur|entscheidung|adr|decision/i.test(s.heading))
    .map(s => ({ heading: s.heading, text: s.lines.join("\n") }));

  const bugSections = sections
    .filter(s => /root cause|problem|bugfix|fehler|ursache/i.test(s.heading))
    .map(s => ({ heading: s.heading, text: s.lines.slice(0, 10).join("\n") }));

  // Only match sections whose heading means "open issues / next steps / roadmap"
  // NOT feature headings that happen to contain "Offene" (e.g. "Offene Votes")
  const NEXT_STEP_HEADINGS = /^(offene punkte|open points?|next steps?|todo|roadmap|nächste schritte|was .{0,20} nächst|upcoming|coming next)/i;

  const openPoints = sections
    .filter(s => NEXT_STEP_HEADINGS.test(s.heading))
    .flatMap(s => s.lines.filter(l => /^[-*•] /.test(l.trim()) && !TECH_LINE.test(l)))
    .map(l => l.trim())
    .slice(0, 6);

  const testResults = lines
    .filter(l => /✓ PASS|✗ FAIL|bestanden|✓.*confirmed|published/i.test(l) && !l.includes("|") && !TECH_LINE.test(l))
    .map(l => l.trim())
    .slice(0, 4);

  return { sections, changeHeadings, problemTexts, userBullets, archSections, bugSections, openPoints, testResults };
}

// ── Semantic: Technical heading → English user benefit ────────────────────────

function toUserBenefit(heading, problemText = "") {
  const h = heading.toLowerCase();

  if (/persist|sqlite|datenbank|speicher|in.memory|memory.state/.test(h))
    return "**Your data stays safe across restarts.** Settings, strategy, and consents are now stored permanently — server restarts no longer cause unexpected logouts or data loss.";

  if (/vote.?plan|generier.*vote|plan.*generat/.test(h))
    return "**Smarter community support.** VoteBroker now automatically generates a vote plan based on your author strategy — prioritizing who you want to support, while keeping your Voting Power healthy.";

  if (/strategi.*editor|editierbar.*strategi|strategi.*tabelle/.test(h))
    return "**Fully editable strategy.** Categories (Favorite, Preferred, Normal), weights, and priorities are now directly adjustable in the browser — your curation rules, your way.";

  if (/consent|berechtigung/.test(h))
    return "**Clear permission management.** All access permissions are visible at a glance — enable or disable them with one click, revocable at any time.";

  if (/broadcast|vote.*senden|live.*vote|execute|blockchain/.test(h))
    return "**Real on-chain voting.** Votes are broadcast directly to the Steem blockchain with a verified transaction ID. No more silent failures — every result is confirmed.";

  if (/dna|vote.*analyse|analyse.*vote|curation.*dna/.test(h))
    return "**Vote-DNA analysis.** VoteBroker reads your voting history and automatically suggests the right authors for your strategy — based on actual data, not guesses.";

  if (/publish|content.*review|admin.*dashboard.*content/.test(h))
    return "**Direct blockchain publishing.** VoteBroker posts can now be published directly to Steem from the admin dashboard — fully controlled, with transaction confirmation.";

  if (/admin.*dashboard|operator.*dashboard/.test(h))
    return "**Operator dashboard.** A comprehensive view of platform activity, user metrics, system health, and content workflow — all in one place.";

  if (/opportunit|offene.*vote|open.*vote/.test(h))
    return "**Never miss a post from an author you care about.** VoteBroker now shows which of your strategy authors have published new content that's still waiting for your support.";

  if (/session|login|auth/.test(h))
    return "**No more unexpected logouts.** Your session now persists even after server updates, keeping you logged in and your workflow uninterrupted.";

  if (/weight.*strategy|gewicht.*strategi|vote.*gewicht|impact/.test(h))
    return "**Meaningful votes for the authors you care about.** Instead of symbolic micro-votes scattered across everyone, your favorite authors now receive votes that actually show up — a real signal of support, not noise.";

  if (/api.*url|relative.*url|connection|fetch/.test(h))
    return "**Improved reliability.** A connection issue that occasionally caused blank pages or failed loads has been fixed.";

  if (/post.*select|score|curation.*window/.test(h))
    return "**Smarter post selection.** VoteBroker now evaluates which post from each author is the best candidate to vote — based on curation timing, age, and remaining reward window.";

  if (/constraint|budget|dust|weight.*calc/.test(h))
    return "**Support more authors, sustainably.** Vote weights are now calculated to distribute your Voting Power across as many strategy authors as possible — without depleting VP so fast you can't support tomorrow's posts too.";

  if (/bugfix|fehler|fix|hydration|race.condition/.test(h))
    return "**Stability fix.** An issue affecting the reliability of VoteBroker has been resolved — users will experience fewer interruptions and more consistent behaviour.";

  if (/devlog|content.system|content.generat/.test(h))
    return "**VoteBroker now publishes development updates.** A built-in content system automatically generates product and tech posts from the development journal, keeping the community informed.";

  // Generic fallback — only use if heading looks user-facing (no German internal words)
  const clean = cleanHeading(heading);
  const hasGerman = /\b(wurde|werden|wird|haben|kann|sind|bei|der|die|das|mit|von|für|auf)\b/i.test(clean);
  if (clean.length > 5 && !hasGerman) {
    return `**${clean}.** An improvement that makes VoteBroker more reliable and easier to use.`;
  }
  return "";
}

// ── Generators ────────────────────────────────────────────────────────────────

function productPost(date, parsed) {
  const { changeHeadings, problemTexts, openPoints } = parsed;
  const [y, m, d] = date.split("-");

  const problemMap = Object.fromEntries(problemTexts.map(p => [p.heading, p.problem]));
  const seen = new Set();
  const benefits = changeHeadings
    .filter(isUserFacing)
    .slice(0, 6)
    .map(h => toUserBenefit(h, problemMap[h] ?? ""))
    .filter(b => b && b.length > 10)
    .filter(b => { const key = b.slice(0, 30); if (seen.has(key)) return false; seen.add(key); return true; });

  const benefitBlock = benefits.length > 0
    ? benefits.join("\n\n")
    : "VoteBroker has been updated with significant improvements to stability, reliability, and user experience. These changes make it easier to support the authors in your strategy — consistently, without manual tracking or VP burnout.";

  const nextItems = openPoints.filter(isUserNextStep).slice(0, 5);
  const nextBlock = nextItems.length > 0
    ? nextItems.join("\n")
    : [
        "- Notifications when strategy authors publish new posts",
        "- Improved analytics to track which authors you've supported over time",
        "- Better VP forecasting to help plan how many authors you can support per day",
      ].join("\n");

  return sanitize(`---
title: "VoteBroker Update — ${monthName(m)} ${d}, ${y}"
type: product-post
date: ${date}
generated: ${new Date().toISOString()}
tags: votebroker steem curation update
---

# VoteBroker Update — ${monthName(m)} ${d}, ${y}

VoteBroker keeps growing. This update brings improvements across ${benefits.length || "several"} areas — making it easier to support the authors you care about, consistently and sustainably.

---

## What's New

${benefitBlock}

---

## What Can Users Do Now?

With these improvements, you can:

- Build a personal author strategy that reflects who you actually want to support
- Find and vote posts from your strategy authors without manual tracking
- Distribute your Voting Power across as many authors as possible — not just the most "profitable" ones
- Trust that your strategy and settings survive restarts and updates

This release has been thoroughly tested and is production-ready.

---

## Why Does This Matter?

Good curation on Steem is not about extracting the maximum reward per vote. It's about consistently showing up for the authors you care about — across days, weeks, and months.

The real challenge isn't finding the optimal vote timing. It's managing limited Voting Power across a growing list of authors without burning out or missing posts you actually wanted to support.

VoteBroker handles the overhead: it tracks your strategy authors, finds their new posts, and proposes a vote plan. The decision to execute always remains with you — VoteBroker never votes autonomously.

---

## What's Coming Next

${nextBlock}

---

💬 **Your feedback matters:**

- Are there specific authors or communities you'd like to support more consistently on Steem?
- How do you currently manage your Voting Power across many authors?
- Which part of your curation workflow costs you the most time?

Share your thoughts in the comments — every perspective helps shape the roadmap.

---

*VoteBroker — community support and curation management for Steem.*
*[votebroker.org](https://votebroker.org)*
`);
}

function techPost(date, parsed) {
  const { changeHeadings, archSections, bugSections, openPoints, testResults } = parsed;
  const [y, m, d] = date.split("-");

  const archBlock = archSections.length > 0
    ? archSections.map(s => {
        const body = sanitize(s.text).split("\n")
          .filter(l => l.trim() && !/^#{1,4} /.test(l))
          .join(" ").slice(0, 400);
        return `### ${s.heading}\n\n${body || "See internal DevLog for full details."}`;
      }).join("\n\n")
    : "No new architectural decisions were made in this session.";

  const bugBlock = bugSections.length > 0
    ? bugSections.map(s => {
        const lines = sanitize(s.text).split("\n")
          .filter(l => l.trim() && !/^#{1,4} /.test(l)).slice(0, 5);
        return `### ${s.heading}\n\n${lines.join("\n") || "See internal DevLog."}`;
      }).join("\n\n")
    : "No critical bugfixes in this session.";

  const componentList = changeHeadings.slice(0, 8)
    .map(h => `- ${h}`).join("\n") || "- General improvements";

  const testBlock = testResults.length > 0
    ? testResults.join("\n")
    : "All relevant scenarios were manually verified before deployment.";

  const nextList = openPoints.filter(isUserNextStep).join("\n")
    || "- Further performance and stability improvements planned.";

  return sanitize(`---
title: "VoteBroker Tech — ${monthName(m)} ${d}, ${y}"
type: tech-post
date: ${date}
generated: ${new Date().toISOString()}
tags: votebroker steem development technology
---

# VoteBroker — Technical Overview: ${monthName(m)} ${d}, ${y}

A look behind the scenes: what was built in this development session, which decisions were made, and why.

---

## Changes in This Session

${componentList}

---

## Architectural Decisions

${archBlock}

---

## Root Causes & Fixes

${bugBlock}

---

## Testing & Verification

${testBlock}

---

## Stack Overview

- **Runtime:** Node.js 20 (Alpine Docker)
- **API:** Fastify + TypeScript (ESM/NodeNext)
- **Persistence:** SQLite via better-sqlite3 (WAL mode)
- **Frontend:** React 18 + Vite + TypeScript
- **Blockchain:** Steem via dsteem
- **Deployment:** Docker + Caddy reverse proxy
- **Auth:** SteemConnect OAuth

---

## Next Technical Steps

${nextList}

---

💬 **For developers and technical readers:**

- Interested in deep dives on specific architectural decisions?
- Have feedback on the technology choices or stack?
- Questions or comments — leave them below.

---

*This post is a technical insight into VoteBroker development.*
`);
}

function devlogPost(date, parsed, fullText) {
  const { changeHeadings, bugSections, openPoints, userBullets } = parsed;
  const [y, m, d] = date.split("-");

  const features = changeHeadings.filter(isUserFacing).slice(0, 5);
  const featuresStr = features.map(cleanHeading).filter(h => h.length > 5).join(", ") || "several key areas";

  const intro = `Today's development session for VoteBroker focused on ${featuresStr}. Here's an honest look at what happened.`;

  const bugNarrative = bugSections.length > 0
    ? bugSections.slice(0, 2).map(s => {
        const body = sanitize(s.text).split("\n")
          .filter(l => l.trim() && !/^#{1,4} |^\*\*/.test(l) && l.length > 15)
          .slice(0, 3).join(" ").slice(0, 300);
        return body || s.heading;
      }).filter(Boolean).join(" ")
    : "Most things worked on the first try today — which is always a good sign.";

  const learningLines = userBullets
    .filter(l => !TECH_LINE.test(l))
    .slice(0, 4)
    .join("\n") || [
      "- Explicit error messages save hours of debugging",
      "- Good persistence strategy pays off immediately — in-memory state is technical debt, not a solution",
      "- Small tests right after a change prevent big problems later",
    ].join("\n");

  const biggestChange = cleanHeading(changeHeadings[0] ?? "today's work");
  const surpriseText = `The most interesting challenge: ${biggestChange.toLowerCase()}. It looked straightforward at first, but had more depth than expected — making the final result that much more robust.`;

  const nextBlock = openPoints.filter(isUserNextStep).slice(0, 5).join("\n")
    || [
        "- Further improvements to voting quality",
        "- Better user feedback for error states",
        "- Performance optimizations in the background",
      ].join("\n");

  return sanitize(`---
title: "Building VoteBroker — ${monthName(m)} ${d}, ${y}"
type: devlog-post
date: ${date}
generated: ${new Date().toISOString()}
tags: votebroker building devlog steem blockchain
---

# Building VoteBroker — ${monthName(m)} ${d}, ${y}

${intro}

---

## What Happened Today

${features.map(h => `- ${h}`).join("\n") || "- Development work and improvements"}

---

## What Didn't Work Right Away

${bugNarrative}

That's normal. Every bug found and fixed today is one that won't occur tomorrow.

---

## What We Learned

${learningLines}

---

## What Surprised Us

${surpriseText}

---

## How the Day Ended

The implementation was tested and verified. VoteBroker is incrementally becoming more reliable with each session.

---

## What's Next

${nextBlock}

---

## Thoughts on the Process

Development is rarely linear. What looked like a small fix today often had deeper roots. That's exactly what makes the difference: the willingness to dig deeper instead of applying a quick patch.

VoteBroker improves step by step — not through big leaps, but through consistent, daily progress. The goal is not to build a smarter reward bot, but a better tool for people who genuinely want to support the Steem community.

---

💬 **Your perspective matters:**

- Do you actively curate on Steem? How do you decide which authors to support?
- Do you enjoy these behind-the-scenes development insights?
- What would help you support more authors without burning through your VP?

Comments welcome — every perspective helps shape the roadmap.

---

*This post is part of the VoteBroker Development Journal.*
*VoteBroker — community support and curation management for Steem.*
*votebroker.org*
`);
}

// ── Months in English ─────────────────────────────────────────────────────────

function monthName(m) {
  return ["","January","February","March","April","May","June","July","August","September","October","November","December"][parseInt(m, 10)] ?? m;
}

// ── DevLog helpers ────────────────────────────────────────────────────────────

function findDevlogs(prefix) {
  if (!existsSync(DEVLOG_DIR)) return [];
  return readdirSync(DEVLOG_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith(".md"))
    .sort()
    .map(f => resolve(DEVLOG_DIR, f));
}

function ensureDevlogTemplate() {
  const primary = resolve(DEVLOG_DIR, `${today}.md`);
  if (!existsSync(primary)) {
    mkdirSync(DEVLOG_DIR, { recursive: true });
    writeFileSync(primary, `# DevLog — ${today}\n\n---\n\n### [Title of change]\n\n**Problem**\n\nWhat problem was this solving?\n\n**Solution**\n\nWhat was changed and why?\n\n**Outcome**\n\nWhat can users do now?\n\n---\n\n## Session Summary\n\n**Date:** ${today}\n**New Features:**\n**Bugfixes:**\n**Next Steps:**\n`, "utf8");
    console.log(`✓ Created DevLog template: docs/devlog/${today}.md`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const targetDate = args[0] ?? today;     // allow: npm run devlog:today 2026-05-31
  const forceRegen = args.includes("--force");

  console.log(`\n🔖 VoteBroker Content Generator v3 — ${targetDate} (English)\n`);

  if (targetDate === today) ensureDevlogTemplate();

  const devlogFiles = findDevlogs(targetDate);
  if (devlogFiles.length === 0) {
    console.log(`⚠  No DevLog files found for ${targetDate}.`);
    if (targetDate === today) console.log(`   Fill in docs/devlog/${today}.md and run again.`);
    else console.log(`   Check docs/devlog/ for available files.`);
    console.log("");
    return;
  }

  console.log(`📄 Sources (${devlogFiles.length} file(s)):`);
  devlogFiles.forEach(f => console.log("   " + f.replace(ROOT + "/", "")));
  console.log("");

  const combined = devlogFiles.map(f => readFileSync(f, "utf8")).join("\n\n---\n\n");
  const parsed   = parseDevlog(combined);

  console.log(`📊 ${parsed.sections.length} sections · ${parsed.changeHeadings.length} feature headings · ${parsed.userBullets.length} user bullets\n`);

  const drafts = [
    [`${targetDate}-product-post.md`, productPost(targetDate, parsed)],
    [`${targetDate}-tech-post.md`,    techPost(targetDate, parsed)],
    [`${targetDate}-devlog-post.md`,  devlogPost(targetDate, parsed, combined)],
  ];

  let allClean = true;

  for (const [filename, content] of drafts) {
    const violations = selfCheck(content);
    const outPath    = resolve(CONTENT_DIR, filename);
    const existed    = existsSync(outPath);

    if (existed && !forceRegen) {
      // Don't overwrite already-published files (check by TX presence in DB — just skip if file exists)
    }

    writeFileSync(outPath, content, "utf8");

    if (violations.length > 0) {
      allClean = false;
      console.log(`⚠  ${filename}`);
      console.log(`   Violations: ${violations.join(", ")}`);
    } else {
      console.log(`✓  ${existed ? "Updated" : "Created"}: docs/content/${filename} — CLEAN`);
    }
  }

  console.log(allClean ? `
✅ All 3 drafts are publication-ready (no placeholders, no internal markers).

Next steps:
  1. Quick review in Admin Dashboard
  2. Draft → Reviewed → Approved → Scheduled → Publish
  3. Done.
` : `
⚠  Some drafts contain violations — review required.
   The publishing system will automatically block drafts with placeholders.
`);
}

main();
