/**
 * International Promo Post Pipeline
 * ===================================
 * Generates a locale-native promotional draft for VoteBroker.
 *
 * 5 Steps:
 *   1. Blockchain scan  — active communities, tags, trending posts for locale
 *   2. Style analysis   — tone, length, format patterns of the community
 *   3. Recommendation   — best community, tags, posting time
 *   4. Screenshots      — UI in the target locale
 *   5. Draft generation — locale-native text using real community data
 */

import { createSteemClient } from "../chain/steemBroadcaster.js";
import { getDb } from "../db/index.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

export type PromoLocale =
  | "en" | "de" | "es" | "pt" | "id" | "ru" | "ko" | "zh" | "ja"
  | "hi" | "bn" | "tr" | "pl" | "pcm";

export interface PromoAnalysis {
  locale:          PromoLocale;
  communities:     Array<{ name: string; postCount: number; topTag: string }>;
  topTags:         string[];
  topAuthors:      string[];
  trendingTopics:  string[];
  styleProfile: {
    avgLength:     "short" | "medium" | "long";
    tone:          "technical" | "storytelling" | "mixed";
    usesLists:     boolean;
    usesImages:    boolean;
  };
  recommendation: {
    community:   string;
    tags:        string[];
    postingHour: number;  // UTC hour with most activity
    reasoning:   string;
  };
  scannedAt: string;
}

export interface PromoResult {
  filename: string;
  analysis: PromoAnalysis;
  screenshotSnap: string | null;
}

// ── Language config ───────────────────────────────────────────────────────────

const LOCALE_CONFIG: Record<PromoLocale, {
  searchTags: string[];
  communityHints: string[];
  greeting: string;
  nativeName: string;
}> = {
  en:  { searchTags:["steem","steemit","curation","blog"], communityHints:["hive-166405","hive-196037"], greeting:"Hello Steem community!", nativeName:"English" },
  de:  { searchTags:["deutsch","germany","steem-germany","german"], communityHints:["hive-148441","steem-germany"], greeting:"Hallo Steem-Community!", nativeName:"Deutsch" },
  es:  { searchTags:["spanish","espanol","castellano","steemit-esp"], communityHints:["hive-108800","hive-111483"], greeting:"¡Hola comunidad Steem!", nativeName:"Español" },
  pt:  { searchTags:["portuguese","brasil","brazil","steemitportugal"], communityHints:["hive-131490"], greeting:"Olá comunidade Steem!", nativeName:"Português" },
  id:  { searchTags:["indonesia","indonesian","bahasa"], communityHints:["hive-138458","indonesia"], greeting:"Halo komunitas Steem!", nativeName:"Bahasa Indonesia" },
  ru:  { searchTags:["russian","russia","ru-steemit","steemrus"], communityHints:["hive-180932"], greeting:"Привет, сообщество Steem!", nativeName:"Русский" },
  ko:  { searchTags:["kr","kr-community","korea","korean"], communityHints:["hive-196037","kr"], greeting:"안녕하세요 Steem 커뮤니티!", nativeName:"한국어" },
  zh:  { searchTags:["cn","chinese","china","steemit-cn"], communityHints:["hive-180932","cn"], greeting:"你好，Steem 社区！", nativeName:"中文" },
  ja:  { searchTags:["japanese","japan","japanese-community"], communityHints:["hive-196037"], greeting:"Steemコミュニティの皆さん、こんにちは！", nativeName:"日本語" },
  hi:  { searchTags:["hindi","india","steemit-india"], communityHints:["hive-180821"], greeting:"नमस्ते Steem समुदाय!", nativeName:"हिन्दी" },
  bn:  { searchTags:["bangladesh","bengali","steemit-bangladesh"], communityHints:["hive-167622"], greeting:"হ্যালো Steem কমিউনিটি!", nativeName:"বাংলা" },
  tr:  { searchTags:["turkish","turkey","steemit-tr"], communityHints:["hive-102708"], greeting:"Merhaba Steem topluluğu!", nativeName:"Türkçe" },
  pl:  { searchTags:["polish","poland","steemit-pl"], communityHints:["hive-196037"], greeting:"Cześć społeczności Steem!", nativeName:"Polski" },
  pcm: { searchTags:["nigeria","naija","africa","steemit-nigeria"], communityHints:["hive-196037"], greeting:"Hello Steem community!", nativeName:"Naija (Nigerian Pidgin)" },
};

// ── Step 1: Blockchain Scan ───────────────────────────────────────────────────

async function scanBlockchain(locale: PromoLocale): Promise<{
  posts: Array<{ title: string; author: string; tags: string[]; body: string; payout: number }>;
  communities: Array<{ name: string; count: number }>;
}> {
  const client = createSteemClient();
  const config = LOCALE_CONFIG[locale];
  const allPosts: Array<{ title: string; author: string; tags: string[]; body: string; payout: number }> = [];
  const communityCounts: Record<string, number> = {};

  for (const tag of config.searchTags.slice(0, 3)) {
    try {
      const posts = await client.database.call("get_discussions_by_trending", [
        { tag, limit: 20, truncate_body: 500 }
      ]) as Array<{
        title: string; author: string; json_metadata?: string;
        pending_payout_value?: string; total_payout_value?: string; body?: string;
        parent_permlink?: string;
      }>;

      for (const p of posts || []) {
        let tags: string[] = [];
        try { tags = JSON.parse(p.json_metadata || "{}").tags || []; } catch {}
        const payout = parseFloat(String(p.pending_payout_value || p.total_payout_value || "0").split(" ")[0]) || 0;
        allPosts.push({ title: p.title || "", author: p.author || "", tags, body: (p.body || "").slice(0, 300), payout });
        // Track community (parent_permlink starting with hive-)
        const community = p.parent_permlink || "";
        if (community.startsWith("hive-") || config.communityHints.includes(community)) {
          communityCounts[community] = (communityCounts[community] || 0) + 1;
        }
      }
    } catch { /* best effort */ }
  }

  // Also scan hot feed
  try {
    const hotPosts = await client.database.call("get_discussions_by_hot", [
      { tag: config.searchTags[0], limit: 15, truncate_body: 300 }
    ]) as Array<{ title: string; author: string; json_metadata?: string; body?: string; pending_payout_value?: string }>;
    for (const p of hotPosts || []) {
      let tags: string[] = [];
      try { tags = JSON.parse(p.json_metadata || "{}").tags || []; } catch {}
      allPosts.push({ title: p.title || "", author: p.author || "", tags, body: (p.body || "").slice(0, 300), payout: parseFloat(String(p.pending_payout_value || "0").split(" ")[0]) || 0 });
    }
  } catch {}

  const communities = Object.entries(communityCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return { posts: allPosts, communities };
}

// ── Step 2: Style Analysis ────────────────────────────────────────────────────

function analyzeStyle(posts: Array<{ body: string; title: string }>): PromoAnalysis["styleProfile"] {
  if (posts.length === 0) return { avgLength: "medium", tone: "mixed", usesLists: false, usesImages: false };

  const bodyLengths = posts.map(p => p.body.length);
  const avgLen = bodyLengths.reduce((a, b) => a + b, 0) / bodyLengths.length;

  const avgLength: "short" | "medium" | "long" = avgLen < 200 ? "short" : avgLen < 800 ? "medium" : "long";

  const technicalWords = /code|api|blockchain|transaction|wallet|token|smart|crypto|bot|script/gi;
  const storyWords = /diary|story|my life|today i|feeling|experience|journey|travel|family/gi;

  let techScore = 0, storyScore = 0;
  for (const p of posts) {
    techScore += (p.body.match(technicalWords) || []).length;
    storyScore += (p.body.match(storyWords) || []).length;
  }

  const tone: "technical" | "storytelling" | "mixed" =
    techScore > storyScore * 2 ? "technical" : storyScore > techScore * 2 ? "storytelling" : "mixed";

  const usesLists = posts.some(p => /^[-*•]\s/m.test(p.body) || /^\d+\.\s/m.test(p.body));
  const usesImages = posts.some(p => /!\[.+\]\(.+\)/.test(p.body) || /<img/i.test(p.body));

  return { avgLength, tone, usesLists, usesImages };
}

// ── Step 3: Recommendation ────────────────────────────────────────────────────

function buildRecommendation(
  locale: PromoLocale,
  posts: Array<{ tags: string[]; payout: number; author: string }>,
  communities: Array<{ name: string; count: number }>,
  style: PromoAnalysis["styleProfile"]
): PromoAnalysis["recommendation"] {
  const config = LOCALE_CONFIG[locale];

  // Tag frequency weighted by payout
  const tagScores: Record<string, number> = {};
  for (const p of posts) {
    for (const tag of p.tags.slice(0, 5)) {
      tagScores[tag] = (tagScores[tag] || 0) + 1 + p.payout * 0.1;
    }
  }

  const topTags = Object.entries(tagScores)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .filter(t => t.length > 2 && !["steemit","steem"].includes(t))
    .slice(0, 6);

  // Community preference: use discovered or hint
  const community = communities.length > 0 ? communities[0].name : (config.communityHints[0] || "");

  // Build tags: locale-specific + general VoteBroker tags
  const tags = [
    ...config.searchTags.slice(0, 2),
    ...topTags.slice(0, 3),
    "votebroker", "curation",
  ].slice(0, 8);

  // Posting time: 14:00-18:00 UTC covers most time zones during their evening
  const postingHour = locale === "ko" || locale === "ja" ? 10 : locale === "id" ? 12 : 15;

  const styleDesc = style.tone === "technical" ? "technical, data-driven content" :
    style.tone === "storytelling" ? "personal stories and experiences" : "a mix of technical and personal content";

  const reasoning = `Community prefers ${styleDesc}. Posts average ${style.avgLength} length. ` +
    `Top tags: ${tags.slice(0, 3).join(", ")}. Optimal posting: ${postingHour}:00 UTC.`;

  return { community, tags, postingHour, reasoning };
}

// ── Community Observation (locale-native, uses real scan data) ─────────────────

// ── Promo Draft Template ─────────────────────────────────────────────────────
// A promo post introduces VoteBroker to the community.
// It is NOT a devlog. It tells a story:
//   - Why was VoteBroker built?
//   - What problem does it solve?
//   - How is it different from classic vote tools?
//   - Which features matter for curators?
//   - Vision and invitation to try it
//
// Community scan data (tags, community, timing) is used for metadata only.

// @deprecated — kept only as fallback reference; not called from generatePromoDraft
function getCommunityObservation(locale: PromoLocale, topics: string[], tag: string, author: string): string {
  const obs: Record<PromoLocale, string> = {
    en: `I've been exploring the **#${tag}** community and noticed active discussions around ${topics.slice(0,2).join(" and ") || "various topics"}. Authors like @${author} are posting consistently. VoteBroker is built exactly for communities like this — to discover active voices earlier and use Voting Power more deliberately.`,
    de: `Ich habe die **#${tag}**-Community durchstöbert und aktive Diskussionen rund um ${topics.slice(0,2).join(" und ") || "verschiedene Themen"} entdeckt. Autoren wie @${author} sind regelmäßig aktiv. VoteBroker ist genau für solche Communitys gebaut — um aktive Stimmen früher zu entdecken.`,
    es: `He explorado la comunidad **#${tag}** y noté discusiones activas sobre ${topics.slice(0,2).join(" y ") || "varios temas"}. Autores como @${author} publican regularmente. VoteBroker está construido exactamente para comunidades como esta.`,
    pt: `Explorei a comunidade **#${tag}** e notei discussões ativas sobre ${topics.slice(0,2).join(" e ") || "vários temas"}. Autores como @${author} publicam regularmente. O VoteBroker foi construído exatamente para comunidades como esta.`,
    id: `Saya menjelajahi komunitas **#${tag}** dan memperhatikan diskusi aktif tentang ${topics.slice(0,2).join(" dan ") || "berbagai topik"}. Penulis seperti @${author} posting secara rutin. VoteBroker dibangun persis untuk komunitas seperti ini.`,
    ru: `Я изучил сообщество **#${tag}** и заметил активные обсуждения на тему ${topics.slice(0,2).join(" и ") || "различных тем"}. Авторы вроде @${author} публикуют регулярно. VoteBroker создан именно для таких сообществ.`,
    ko: `**#${tag}** 커뮤니티를 탐색하다가 ${topics.slice(0,2).join(" 및 ") || "다양한 주제"}에 관한 활발한 토론을 발견했습니다. @${author} 같은 작가들이 꾸준히 활동합니다. VoteBroker는 바로 이런 커뮤니티를 위해 만들어졌습니다.`,
    zh: `我浏览了 **#${tag}** 社区，注意到关于${topics.slice(0,2).join("和") || "各种话题"}的活跃讨论。像 @${author} 这样的作者定期发帖。VoteBroker 就是为这样的社区而生的。`,
    ja: `**#${tag}**コミュニティを探索して、${topics.slice(0,2).join("と") || "様々なトピック"}に関する活発な議論を見つけました。@${author}のような著者が定期的に投稿しています。`,
    hi: `मैंने **#${tag}** समुदाय को एक्सप्लोर किया और ${topics.slice(0,2).join(" और ") || "विभिन्न विषयों"} पर सक्रिय चर्चाएं देखीं। @${author} जैसे लेखक नियमित रूप से पोस्ट करते हैं।`,
    bn: `আমি **#${tag}** কমিউনিটি অন্বেষণ করলাম এবং ${topics.slice(0,2).join(" এবং ") || "বিভিন্ন বিষয়"} নিয়ে সক্রিয় আলোচনা দেখলাম। @${author}-এর মতো লেখকরা নিয়মিত পোস্ট করেন।`,
    tr: `**#${tag}** topluluğunu keşfettim ve ${topics.slice(0,2).join(" ve ") || "çeşitli konular"} hakkında aktif tartışmalar gördüm. @${author} gibi yazarlar düzenli olarak paylaşım yapıyor.`,
    pl: `Przeglądałem społeczność **#${tag}** i zauważyłem aktywne dyskusje na temat ${topics.slice(0,2).join(" i ") || "różnych tematów"}. Autorzy tacy jak @${author} publikują regularnie.`,
    pcm: `I don explore **#${tag}** community and see plenty active discussions about ${topics.slice(0,2).join(" and ") || "different topics"}. Authors like @${author} dey post regular. VoteBroker na exactly wetin dis kind community need.`,
  };
  return obs[locale] || obs.en;
}

// ── Step 5: Draft Generation ──────────────────────────────────────────────────

function generatePromoDraft(locale: PromoLocale, analysis: PromoAnalysis): string {
  const config = LOCALE_CONFIG[locale];
  const { recommendation } = analysis;

  // Community scan provides tags, community, timing — NOT the content body.
  const tagsLine = `**Tags:** ${recommendation.tags.map(t => `#${t}`).join(" ")}`;
  const communityLine = recommendation.community ? `**Community:** ${recommendation.community}` : "";

  // ── Titles ──────────────────────────────────────────────────────────────────
  const TITLES: Record<string, string> = {
    de:  "VoteBroker — Wie ich mein Curation-System auf Steem neu aufgebaut habe",
    en:  "VoteBroker — How I rebuilt my curation system on Steem",
    es:  "VoteBroker — Cómo reconstruí mi sistema de curación en Steem",
    pt:  "VoteBroker — Como reconstruí meu sistema de curadoria no Steem",
    id:  "VoteBroker — Bagaimana Saya Membangun Ulang Sistem Kurasi di Steem",
    ru:  "VoteBroker — Как я перестроил свою систему кураторства на Steem",
    ko:  "VoteBroker — Steem에서 나의 큐레이션 시스템을 재구축한 방법",
    zh:  "VoteBroker — 我如何在 Steem 上重建我的策展系统",
    ja:  "なぜ私はVoteBrokerを作ったのか",
    hi:  "VoteBroker — मैंने Steem पर अपना क्यूरेशन सिस्टम कैसे बनाया",
    bn:  "VoteBroker — আমি কীভাবে Steem-এ আমার কিউরেশন সিস্টেম পুনর্নির্মাণ করলাম",
    tr:  "VoteBroker — Steem'de Kürasyon Sistemimi Nasıl Yeniden Kurdum",
    pl:  "VoteBroker — Jak przebudowałem swój system kuracji na Steem",
    pcm: "VoteBroker — How I Build Better Curation System for Steem",
  };

  // ── Body templates — product story, not community scan ───────────────────────
  // Structure per locale:
  //   1. Hook: the problem with old vote tools
  //   2. Story: why VoteBroker was built
  //   3. What it does differently (consent, USD strategies, Vote-DNA, Community Intelligence)
  //   4. Vision
  //   5. CTA
  const BODIES: Record<string, string> = {
    de: `${config.greeting}

Ich möchte euch heute ein Open-Source-Projekt vorstellen, an dem ich seit einiger Zeit arbeite: **VoteBroker**.

---

## Das Problem

Wer auf Steem kuriert, kennt das: Man möchte gute Autoren unterstützen, aber die Voting Power ist schnell aufgebraucht. Klassische Vote-Bots setzen Votes automatisch — ohne Kontext, ohne Kontrolle, ohne echte Strategie.

Ich wollte etwas anderes bauen.

---

## Was ist VoteBroker?

VoteBroker ist kein Vote-Bot. Es ist ein **Curation-System**, das mir hilft, bessere Entscheidungen zu treffen — nicht statt mir.

**Wer entwickelt es?**
Ich, Jan-Philipp Vieth — ein Entwickler aus der Steem-Community. VoteBroker ist Open Source und unter [github.com/jan-philippvieth-svg/votebroker-modern](https://github.com/jan-philippvieth-svg/votebroker-modern) frei zugänglich.

---

## Was macht es anders?

**1. Explizites Consent-Modell**
Login ist nicht gleich Erlaubnis. Jeder operative Schritt — Vote absenden, Fee-Post, Community-Daten — wird separat bestätigt. Du kannst jede Berechtigung jederzeit widerrufen.

**2. USD-präzise Vote-Strategien**
Statt prozentualem Gewicht setzt man einen Zielwert in USD. VoteBroker berechnet daraus das exakte Gewicht auf Basis der aktuellen Voting Power und des STEEM-Preises.

**3. Vote-DNA — optimaler Zeitpunkt, optimales Gewicht**
Das System analysiert historische Curation-Daten und schlägt vor, wann und mit welchem Gewicht ein Vote maximalen Curation-Reward erzielt.

**4. Community Intelligence**
Der Autor-Radar zeigt, welche Autoren von mehreren erfahrenen Kuratoren unabhängig voneinander unterstützt werden — ein starkes Signal für Qualität.

**5. Power-Stable Modus**
VoteBroker empfiehlt das maximale Vote-Gewicht, das die Voting Power langfristig stabil hält.

---

## Warum ich das gebaut habe

Ich wollte nicht blind voten. Ich wollte verstehen, warum ein Vote gut oder schlecht ist. VoteBroker macht Kuration transparent — mit echten Daten aus der Blockchain.

Das Tool ist kostenlos nutzbar. Eine kleine Service-Gebühr fällt nur bei genutzten Votes an — abgerechnet als Vote auf einen ausgewiesenen Fee-Post. Kein Token-Transfer, alles on-chain.

---

## Was noch kommt

VoteBroker ist Work in Progress. Fertig und nutzbar sind: Dashboard, Vote-DNA, Community Intelligence und das Consent-System. Was ich noch plane:

- Direkte Veröffentlichung von Drafts aus dem Admin-Panel
- Mehr Sprachen und Community-spezifische Anpassungen
- Verbesserungen bei der Timing-Intelligenz

---

**Jetzt ausprobieren:** https://votebroker.org

Ich freue mich auf Feedback — was fehlt, was würde euch wirklich helfen, was findet ihr gut oder weniger gut? Ehrliche Meinungen sind wertvoller als Lob.`,

    en: `${config.greeting}

Today I want to introduce an open-source project I've been building: **VoteBroker**.

---

## The Problem

Anyone who curates on Steem knows the challenge: you want to support good authors, but Voting Power runs out fast. Classic vote bots cast votes automatically — without context, without control, without a real strategy.

I wanted to build something different.

---

## What is VoteBroker?

VoteBroker is not a vote bot. It's a **curation system** that helps me make better decisions — not instead of me.

**Who built it?**
Me, Jan-Philipp Vieth — a developer in the Steem community. VoteBroker is open source and freely available at [github.com/jan-philippvieth-svg/votebroker-modern](https://github.com/jan-philippvieth-svg/votebroker-modern).

---

## What makes it different?

**1. Explicit Consent Model**
Login is not permission. Every operational step — sending a vote, fee posts, community data — requires separate confirmation. You can revoke any permission at any time.

**2. USD-precise Vote Strategies**
Instead of percentage weights, you set a target value in USD. VoteBroker calculates the exact weight based on your current Voting Power and the STEEM price.

**3. Vote-DNA — optimal timing, optimal weight**
The system analyzes historical curation data and recommends when and at what weight a vote will generate maximum curation rewards.

**4. Community Intelligence**
The Author Radar shows which authors are independently supported by multiple experienced curators — a strong signal for quality content.

**5. Power-Stable Mode**
VoteBroker recommends the maximum vote weight that keeps your Voting Power stable long-term.

---

## Why I built this

I didn't want to vote blindly. I wanted to understand why a vote is good or bad. VoteBroker makes curation transparent — with real data from the blockchain.

The tool is free to use. A small service fee only applies to votes cast — settled as a vote on a designated fee post. No token transfer, everything on-chain.

---

## What's still in progress

VoteBroker is a work in progress. What's working today: Dashboard, Vote-DNA, Community Intelligence, and the consent system. What I'm still building:

- Direct publishing of drafts from the admin panel
- More languages and community-specific tuning
- Improvements to timing intelligence

---

**Try it now:** https://votebroker.org

I'd love honest feedback — what's missing, what would actually help you, what works and what doesn't? Real opinions are more valuable than praise.`,

    ko: `${config.greeting}

오늘 제가 만들고 있는 오픈소스 프로젝트를 소개하고 싶습니다: **VoteBroker**.

---

## 문제점

Steem에서 큐레이션을 해보신 분이라면 아실 겁니다. 좋은 작가들을 지원하고 싶지만 투표력(Voting Power)은 빨리 소진됩니다. 기존 보팅 봇들은 자동으로 투표하지만 — 맥락도, 통제권도, 실제 전략도 없이.

저는 다른 것을 만들고 싶었습니다.

---

## VoteBroker란?

VoteBroker는 봇이 아닙니다. 저 대신이 아니라, 더 나은 결정을 내리도록 도와주는 **큐레이션 시스템**입니다.

**누가 만들었나요?**
저, Jan-Philipp Vieth — Steem 커뮤니티의 개발자입니다. VoteBroker는 오픈소스이며 [github.com/jan-philippvieth-svg/votebroker-modern](https://github.com/jan-philippvieth-svg/votebroker-modern)에서 무료로 이용 가능합니다.

---

## 무엇이 다른가요?

**1. 명시적 동의 모델**
로그인 ≠ 권한. 모든 작업 — 투표 전송, 수수료 포스트, 커뮤니티 데이터 — 은 별도 확인이 필요합니다. 언제든지 모든 권한을 취소할 수 있습니다.

**2. USD 정밀 투표 전략**
퍼센트 가중치 대신 USD 목표값을 설정합니다. VoteBroker는 현재 투표력과 STEEM 가격을 기반으로 정확한 가중치를 계산합니다.

**3. 투표 DNA — 최적 타이밍, 최적 가중치**
시스템이 과거 큐레이션 데이터를 분석하여 최대 큐레이션 보상을 얻을 수 있는 시기와 가중치를 추천합니다.

**4. 커뮤니티 인텔리전스**
저자 레이더는 여러 경험 많은 큐레이터들이 독립적으로 지지하는 작가를 보여줍니다 — 품질 콘텐츠의 강력한 신호입니다.

**5. 파워 스테이블 모드**
장기적으로 투표력을 안정적으로 유지하는 최대 투표 가중치를 추천합니다.

---

**지금 사용해보기:** https://votebroker.org

여러분의 피드백을 기다립니다 — 무엇이 부족한지, 더 나아질 수 있는 것이 무엇인지 알려주세요.`,

    ja: `${LOCALE_CONFIG.ja.greeting}

私は **VoteBroker** というオープンソースのツールを作っています。今日は、なぜ作ったのかをお話しさせてください。

---

## きっかけ

Steemでキュレーションを続けるうち、ずっと気になっていたことがありました。

**盲目的に投票したくなかった。**

自動投票ボットは手軽ですが、「なぜこの投稿に投票するのか」が見えない。設定したリストを機械的に処理するだけで、投票パワーがどう使われているか、本当に良い投稿を支援できているかどうか、わからないまま動き続けます。

既存のツールを試してみましたが、どれも似たような問題がありました。コントロールが少ない。透明性がない。自分のキュレーション判断を、ツールに全部委ねるような設計になっている。

私が欲しかったのは「代わりに動くボット」ではなく、**自分がより良い判断を下すための道具**でした。

---

## VoteBrokerでできること（今の段階で）

いくつか特徴的な機能がありますが、特に気に入っているものを二つ挙げます。

**投票DNA**
過去のブロックチェーンデータを分析して、「このタイミングで、このウェイトで投票すれば、キュレーション報酬が最大になる」という提案をしてくれます。勘ではなく、データに基づいた判断ができるようになりました。

**同意モデル**
ログインしただけで何でも許可されるわけではありません。投票の送信、手数料の精算、コミュニティデータの参加、それぞれ個別に許可が必要で、いつでも取り消せます。自分のアカウントで何が起きているか、常に把握できる仕組みです。

---

## オープンソースであることについて

コードはすべて公開しています。

[github.com/jan-philippvieth-svg/votebroker-modern](https://github.com/jan-philippvieth-svg/votebroker-modern)

何かを隠しているわけでも、ブラックボックスで動いているわけでもありません。自分のアカウントを信頼して使ってもらうなら、コードを見せるのは当然だと思っています。

---

## まだ開発中です

正直に言うと、VoteBrokerはまだ途上のプロジェクトです。今動いている機能（ダッシュボード、投票DNA、コミュニティインテリジェンス）は実際に使えますが、改善したい点もたくさんあります。

フィードバックがあれば、ぜひ教えてください。特に「こういう機能があれば使いたい」「ここが使いにくい」という声は、とても参考になります。

**試してみる：** https://votebroker.org`,
  };

  // Fallback to EN for locales without native template yet
  const body = BODIES[locale] ?? BODIES.en;
  const title = TITLES[locale] ?? TITLES.en;

  // Analyse metadata — visible in review, not publishable
  const analyseMeta = `<!--
ANALYSE (für Review — wird nicht veröffentlicht)
Sprache:    ${config.nativeName} (${locale})
Community:  ${recommendation.community || "keine eindeutige Community"}
Tags:       ${recommendation.tags.join(", ")}
Autoren:    ${analysis.topAuthors.slice(0, 5).join(", ") || "keine"}
Stil:       ${analysis.styleProfile.tone} · ${analysis.styleProfile.avgLength}
Posting:    ${recommendation.postingHour}:00 UTC
Begründung: ${recommendation.reasoning}
HINWEIS:    Draft-Template — Inhalt für die Zielsprache vor Veröffentlichung prüfen.
-->

`;

  return `---
title: "${title}"
date: ${new Date().toISOString().slice(0, 10)}
type: promo-post
locale: ${locale}
---

${analyseMeta}# ${title}

${body}

---

${communityLine ? communityLine + "\n" : ""}${tagsLine}

---

*VoteBroker — Open Source · [votebroker.org](https://votebroker.org) · [GitHub](https://github.com/jan-philippvieth-svg/votebroker-modern)*
`;
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────

export async function generatePromoPost(
  locale: PromoLocale,
  contentDir: string,
  log: typeof console = console,
): Promise<PromoResult> {
  log.info(`[PromoPost] Starting pipeline for locale: ${locale}`);

  // Step 1: Blockchain scan
  log.info("[PromoPost] Step 1: Blockchain scan…");
  const { posts, communities } = await scanBlockchain(locale);
  log.info(`[PromoPost] Found ${posts.length} posts, ${communities.length} communities`);

  // Step 2: Style analysis
  log.info("[PromoPost] Step 2: Style analysis…");
  const styleProfile = analyzeStyle(posts);

  // Extract top authors and trending topics
  const authorCounts: Record<string, number> = {};
  const allTags: string[] = [];
  for (const p of posts) {
    authorCounts[p.author] = (authorCounts[p.author] || 0) + 1;
    allTags.push(...p.tags);
  }
  const topAuthors = Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a);
  const tagFreq: Record<string, number> = {};
  for (const t of allTags) tagFreq[t] = (tagFreq[t] || 0) + 1;
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);
  const trendingTopics = posts.slice(0, 5).map(p => p.title).filter(Boolean);

  // Step 3: Recommendation
  log.info("[PromoPost] Step 3: Building recommendation…");
  const recommendation = buildRecommendation(locale, posts, communities, styleProfile);

  const analysis: PromoAnalysis = {
    locale,
    communities: communities.map(c => ({ name: c.name, postCount: c.count, topTag: topTags[0] || "" })),
    topTags,
    topAuthors,
    trendingTopics,
    styleProfile,
    recommendation,
    scannedAt: new Date().toISOString(),
  };

  // Step 4: Screenshots in target locale
  log.info(`[PromoPost] Step 4: Capturing screenshots in locale '${locale}'…`);
  let screenshotSnap: string | null = null;
  try {
    screenshotSnap = await capturePromoScreenshots(locale, log);
    if (screenshotSnap) {
      log.info(`[PromoPost] Screenshots captured: ${screenshotSnap}`);
    }
  } catch (err) {
    log.warn({ err }, "[PromoPost] Screenshot capture failed — continuing without screenshots");

  }

  // Step 5: Generate draft
  log.info("[PromoPost] Step 5: Generating draft…");
  const draftContent = generatePromoDraft(locale, analysis);

  // Save to content_drafts
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-promo-${locale}.md`;
  const filepath = join(contentDir, filename);

  await mkdir(contentDir, { recursive: true });
  await writeFile(filepath, draftContent, "utf8");

  const db = getDb();
  const titleLine = draftContent.match(/^title:\s*"(.+)"/m)?.[1] || `VoteBroker Promo — ${locale.toUpperCase()}`;

  db.prepare(`
    INSERT OR REPLACE INTO content_drafts
      (filename, date_str, type, title, status, notes, screenshot_snap, created_at, updated_at)
    VALUES (?, ?, 'promo-post', ?, 'draft', ?, ?, datetime('now'), datetime('now'))
  `).run(filename, date, titleLine, JSON.stringify(analysis), screenshotSnap ?? null);

  log.info(`[PromoPost] Done — ${filename}${screenshotSnap ? ` (snap: ${screenshotSnap})` : ""}`);
  return { filename, analysis, screenshotSnap };
}

// ── Screenshot Capture ────────────────────────────────────────────────────────

async function capturePromoScreenshots(locale: PromoLocale, log: typeof console): Promise<string | null> {
  // Reuses the same screenshot pipeline as devlogs (VOTEBROKER_SCREENSHOT_SCRIPT).
  // capture.py runs with PROMO_LOCALE set → injects locale into localStorage,
  // writes screenshots to VOTEBROKER_SCREENSHOTS_DIR/snap-promo-{locale}-{date}/,
  // and prints SNAP_NAME=... to stdout.
  const captureScript = process.env.VOTEBROKER_SCREENSHOT_SCRIPT ?? "";
  if (!captureScript || !existsSync(captureScript)) {
    log.info(
      `[PromoPost] VOTEBROKER_SCREENSHOT_SCRIPT not set or not found — screenshots skipped. ` +
      `Manual: SESSION_TOKEN=<t> PROMO_LOCALE=${locale} python3 tools/showcase/capture.py`
    );
    return null;
  }

  const sessionToken = process.env.SESSION_TOKEN ?? process.env.VOTEBROKER_SCREENSHOT_TOKEN ?? "";
  if (!sessionToken) {
    log.info("[PromoPost] SESSION_TOKEN not set — screenshots skipped");
    return null;
  }

  const screenshotsDir = process.env.VOTEBROKER_SCREENSHOTS_DIR
    ?? (existsSync("/app/data") ? "/app/data/screenshots" : "/tmp/votebroker-screenshots");

  const env = {
    ...process.env,
    SESSION_TOKEN:              sessionToken,
    PROMO_LOCALE:               locale,
    VOTEBROKER_SCREENSHOTS_DIR: screenshotsDir,
  };

  const { stdout } = await execFileAsync("python3", [captureScript], { env, timeout: 120_000 });
  log.info("[PromoPost] capture.py output:", stdout.slice(0, 400));

  const match = stdout.match(/SNAP_NAME=(\S+)/);
  return match?.[1] ?? null;
}
