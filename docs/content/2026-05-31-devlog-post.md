---
title: "Building VoteBroker — May 31, 2026"
type: devlog-post
date: 2026-05-31
generated: 2026-05-31T22:33:42.440Z
tags: votebroker building devlog steem blockchain
---

# Building VoteBroker — May 31, 2026

Today's development session for VoteBroker focused on In-memory state lost after container restart, Hydration Race-Condition Fix, Vote-DNA Tab: Erste Überarbeitung, Vote-DNA API nicht erreichbar, Vote-DNA Strategy Editor: Editierbare Strategie-Tabelle. Here's an honest look at what happened.

---

## What Happened Today

- Root cause: In-memory state lost after container restart
- Hydration Race-Condition Fix
- Vote-DNA Tab: Erste Überarbeitung (Analyse → Onboarding-Tool)
- Bugfix: Vote-DNA API nicht erreichbar (Failed to fetch)
- Vote-DNA Strategy Editor: Editierbare Strategie-Tabelle

---

## What Didn't Work Right Away

`sessionStore.ts` und `consentStore.ts` verwendeten `Map<>` im Prozessspeicher. Bei jedem Container-Neustart wurden alle Sessions und Consents gelöscht: - Nutzer wurden automatisch ausgeloggt `api.ts` hatte `const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000"`. Die `.env`-Datei mit `VITE_API_BASE=/api` lag im Monorepo-Root `/opt/votebroker-modern/.env`, aber Vite liest `.env` nur aus dem Workspace-Verzeichnis `apps/web/`. Damit fiel der Build auf `http://localhost:3

That's normal. Every bug found and fixed today is one that won't occur tomorrow.

---

## What We Learned

- Nutzer wurden automatisch ausgeloggt
- Vote-Consent musste nach jedem Restart erneut erteilt werden
- Strategie-Regeln existierten nur im Browser (localStorage)
- Posting-Authority wurde bei jedem Vote erneut vom Steem-Node abgefragt

---

## What Surprised Us

The most interesting challenge: in-memory state lost after container restart. It looked straightforward at first, but had more depth than expected — making the final result that much more robust.

---

## How the Day Ended

The implementation was tested and verified. VoteBroker is incrementally becoming more reliable with each session.

---

## What's Next

- Further improvements to voting quality
- Better user feedback for error states
- Performance optimizations in the background

---

## Thoughts on the Process

Development is rarely linear. What looked like a small fix today often had deeper roots. That's exactly what makes the difference: the willingness to dig deeper instead of applying a quick patch.

VoteBroker improves step by step — not through big leaps, but through consistent, daily progress.

---

💬 **Your perspective matters:**

- Do you use Steem actively for curation? What frustrates you most?
- Do you enjoy these behind-the-scenes development insights?
- What would you improve in VoteBroker next?

Comments welcome — every perspective helps shape the roadmap.

---

*This post is part of the VoteBroker Development Journal.*
*votebroker.org*
