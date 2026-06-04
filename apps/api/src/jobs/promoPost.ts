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
  const { styleProfile, recommendation, topAuthors, trendingTopics } = analysis;

  const communityName = recommendation.community || config.searchTags[0];
  const topAuthor = topAuthors[0] || "active community members";
  const topic = trendingTopics[0] || "quality content";

  const isLong = styleProfile.avgLength === "long";
  const isTechnical = styleProfile.tone === "technical";

  // Locale-specific intro patterns
  const INTROS: Record<string, string> = {
    en: `${config.greeting}\n\nI want to share a tool that has been making my curation work much more effective: **VoteBroker**.`,
    de: `${config.greeting}\n\nIch möchte euch ein Werkzeug vorstellen, das meine Kurationsstrategie deutlich verbessert hat: **VoteBroker**.`,
    es: `${config.greeting}\n\nQuiero compartir con ustedes una herramienta que ha mejorado mucho mi trabajo de curación: **VoteBroker**.`,
    pt: `${config.greeting}\n\nQuero compartilhar uma ferramenta que melhorou muito meu trabalho de curadoria: **VoteBroker**.`,
    id: `${config.greeting}\n\nSaya ingin berbagi alat yang telah membuat pekerjaan kurasi saya jauh lebih efektif: **VoteBroker**.`,
    ru: `${config.greeting}\n\nХочу поделиться инструментом, который значительно улучшил мою работу по куратории: **VoteBroker**.`,
    ko: `${config.greeting}\n\n큐레이션 작업을 훨씬 효과적으로 만들어준 도구를 소개하고 싶습니다: **VoteBroker**.`,
    zh: `${config.greeting}\n\n我想和大家分享一个让我的策展工作更有效率的工具：**VoteBroker**。`,
    ja: `${config.greeting}\n\nキュレーション活動をより効果的にするツールをご紹介したいと思います：**VoteBroker**。`,
    hi: `${config.greeting}\n\nमैं एक ऐसे टूल के बारे में बताना चाहता हूं जिसने मेरी क्यूरेशन को बहुत बेहतर बना दिया है: **VoteBroker**।`,
    bn: `${config.greeting}\n\nআমি একটি টুল শেয়ার করতে চাই যা আমার কিউরেশন কাজকে অনেক কার্যকর করেছে: **VoteBroker**।`,
    tr: `${config.greeting}\n\nKürasyon çalışmamı çok daha etkili hale getiren bir araç paylaşmak istiyorum: **VoteBroker**.`,
    pl: `${config.greeting}\n\nChcę podzielić się narzędziem, które znacznie poprawiło moją pracę z kuracją: **VoteBroker**.`,
    pcm: `${config.greeting}\n\nI wan share one tool wey don make my curation work beta: **VoteBroker**.`,
  };

  const intro = INTROS[locale] || INTROS.en;

  // Core sections — adapt based on style profile
  const listMarker = styleProfile.usesLists ? "- " : "• ";

  const CORE: Record<string, string> = {
    en: `If you're active in the **${communityName}** community like authors such as @${topAuthor}, you know how challenging it can be to consistently find and support quality content.\n\n**What VoteBroker does:**\n\n${listMarker}Automatically scans for new posts from your favorite authors\n${listMarker}Manages your Voting Power intelligently\n${listMarker}Shows you real-time curation analytics\n${listMarker}Helps you discover new voices through community signals`,
    de: `Wenn du in der **${communityName}**-Community aktiv bist, weißt du wie zeitaufwendig gute Kuration sein kann.\n\n**Was VoteBroker macht:**\n\n${listMarker}Scannt automatisch neue Posts deiner Lieblingsautoren\n${listMarker}Verwaltet deine Voting Power intelligent\n${listMarker}Zeigt Echtzeit-Kurationsdaten\n${listMarker}Hilft dir neue Autoren durch Community-Signale zu entdecken`,
    es: `Si eres activo en la comunidad **${communityName}**, sabes lo desafiante que puede ser la curación constante.\n\n**Qué hace VoteBroker:**\n\n${listMarker}Escanea automáticamente nuevos posts de tus autores favoritos\n${listMarker}Gestiona tu Voting Power de forma inteligente\n${listMarker}Muestra análisis de curación en tiempo real\n${listMarker}Te ayuda a descubrir nuevas voces`,
    pt: `Se você é ativo na comunidade **${communityName}**, sabe como pode ser desafiador manter uma curadoria consistente.\n\n**O que o VoteBroker faz:**\n\n${listMarker}Escaneia automaticamente novos posts dos seus autores favoritos\n${listMarker}Gerencia seu Voting Power de forma inteligente\n${listMarker}Exibe análises de curadoria em tempo real\n${listMarker}Ajuda a descobrir novas vozes`,
    id: `Jika kamu aktif di komunitas **${communityName}**, kamu tahu betapa sulitnya melakukan kurasi yang konsisten.\n\n**Apa yang VoteBroker lakukan:**\n\n${listMarker}Secara otomatis memindai postingan baru dari penulis favoritmu\n${listMarker}Mengelola Voting Power-mu secara cerdas\n${listMarker}Menampilkan analitik kurasi secara real-time\n${listMarker}Membantu menemukan suara-suara baru`,
    ru: `Если вы активны в сообществе **${communityName}**, вы знаете, насколько сложно поддерживать последовательную курацию.\n\n**Что делает VoteBroker:**\n\n${listMarker}Автоматически сканирует новые посты ваших любимых авторов\n${listMarker}Умно управляет вашей Voting Power\n${listMarker}Показывает аналитику кураторства в реальном времени\n${listMarker}Помогает открывать новые голоса через сигналы сообщества`,
    ko: `**${communityName}** 커뮤니티에서 활동하신다면, 꾸준한 큐레이션이 얼마나 어려운지 아실 것입니다.\n\n**VoteBroker가 하는 일:**\n\n${listMarker}즐겨찾는 작가들의 새 게시물 자동 스캔\n${listMarker}투표력(Voting Power) 지능적 관리\n${listMarker}실시간 큐레이션 분석 제공\n${listMarker}커뮤니티 신호를 통한 새로운 목소리 발견`,
    zh: `如果您活跃在 **${communityName}** 社区，您一定知道持续策展有多么挑战。\n\n**VoteBroker 能做什么：**\n\n${listMarker}自动扫描您喜爱作者的新帖子\n${listMarker}智能管理您的 Voting Power\n${listMarker}实时显示策展分析数据\n${listMarker}通过社区信号帮助发现新声音`,
    ja: `**${communityName}**コミュニティで活動されているなら、継続的なキュレーションがどれほど難しいかご存知でしょう。\n\n**VoteBrokerができること：**\n\n${listMarker}お気に入りの著者の新しい投稿を自動的にスキャン\n${listMarker}Voting Powerをインテリジェントに管理\n${listMarker}リアルタイムのキュレーション分析を表示\n${listMarker}コミュニティシグナルで新しい声を発見`,
    hi: `यदि आप **${communityName}** समुदाय में सक्रिय हैं, तो आप जानते हैं कि लगातार क्यूरेशन कितना चुनौतीपूर्ण हो सकता है।\n\n**VoteBroker क्या करता है:**\n\n${listMarker}अपने पसंदीदा लेखकों के नए पोस्ट स्वचालित रूप से स्कैन करता है\n${listMarker}आपकी Voting Power को बुद्धिमानी से प्रबंधित करता है\n${listMarker}रियल-टाइम क्यूरेशन एनालिटिक्स दिखाता है`,
    bn: `যদি আপনি **${communityName}** সম্প্রদায়ে সক্রিয় থাকেন, তাহলে আপনি জানেন ধারাবাহিক কিউরেশন কতটা চ্যালেঞ্জিং হতে পারে।\n\n**VoteBroker কী করে:**\n\n${listMarker}আপনার প্রিয় লেখকদের নতুন পোস্ট স্বয়ংক্রিয়ভাবে স্ক্যান করে\n${listMarker}আপনার Voting Power বুদ্ধিমত্তার সাথে পরিচালনা করে\n${listMarker}রিয়েল-টাইম কিউরেশন বিশ্লেষণ দেখায়`,
    tr: `**${communityName}** topluluğunda aktifseniz, tutarlı kürasyon yapmanın ne kadar zor olduğunu bilirsiniz.\n\n**VoteBroker'ın yaptıkları:**\n\n${listMarker}Favori yazarlarınızın yeni gönderilerini otomatik olarak tarar\n${listMarker}Voting Power'ınızı akıllıca yönetir\n${listMarker}Gerçek zamanlı kürasyon analitiği gösterir\n${listMarker}Topluluk sinyalleri aracılığıyla yeni sesleri keşfetmenize yardımcı olur`,
    pl: `Jeśli jesteś aktywny w społeczności **${communityName}**, wiesz jak trudna może być systematyczna kuracja.\n\n**Co robi VoteBroker:**\n\n${listMarker}Automatycznie skanuje nowe posty ulubionych autorów\n${listMarker}Inteligentnie zarządza Voting Power\n${listMarker}Wyświetla analizy kuracji w czasie rzeczywistym\n${listMarker}Pomaga odkrywać nowe głosy przez sygnały społeczności`,
    pcm: `If you dey active for **${communityName}** community, you know say consistent curation no easy.\n\n**Wetin VoteBroker dey do:**\n\n${listMarker}E go automatically scan new posts from your favorite authors\n${listMarker}E go manage your Voting Power wisely\n${listMarker}E go show you real-time curation analytics\n${listMarker}E go help you discover new voices`,
  };

  const core = CORE[locale] || CORE.en;

  // CTA section
  const CTAS: Record<string, string> = {
    en: `**Try VoteBroker:** https://votebroker.org\n\nI'd love to hear your thoughts. Have you tried automated curation tools before? What's your experience with ${topic} on Steem?`,
    de: `**VoteBroker ausprobieren:** https://votebroker.org\n\nIch freue mich auf eure Gedanken. Habt ihr schon automatisierte Kurationswerkzeuge genutzt?`,
    es: `**Prueba VoteBroker:** https://votebroker.org\n\nMe encantaría escuchar tu opinión. ¿Has probado antes herramientas de curación automatizadas?`,
    pt: `**Experimente o VoteBroker:** https://votebroker.org\n\nGostaria de ouvir sua opinião. Você já usou ferramentas de curadoria automatizadas antes?`,
    id: `**Coba VoteBroker:** https://votebroker.org\n\nSaya ingin mendengar pendapatmu. Sudahkah kamu mencoba alat kurasi otomatis sebelumnya?`,
    ru: `**Попробуйте VoteBroker:** https://votebroker.org\n\nБуду рад услышать ваши мысли. Пробовали ли вы раньше инструменты автоматической кураторства?`,
    ko: `**VoteBroker 사용해보기:** https://votebroker.org\n\n여러분의 의견을 듣고 싶습니다. 이전에 자동화된 큐레이션 도구를 사용해 본 적 있으신가요?`,
    zh: `**试用 VoteBroker：** https://votebroker.org\n\n我很想听听您的想法。您以前使用过自动化策展工具吗？`,
    ja: `**VoteBrokerを試してみる：** https://votebroker.org\n\nご意見をぜひお聞かせください。以前に自動キュレーションツールを使ったことはありますか？`,
    hi: `**VoteBroker आज़माएं:** https://votebroker.org\n\nमैं आपके विचार सुनना चाहूंगा। क्या आपने पहले स्वचालित क्यूरेशन टूल का उपयोग किया है?`,
    bn: `**VoteBroker চেষ্টা করুন:** https://votebroker.org\n\nআমি আপনার মতামত শুনতে চাই। আপনি কি আগে স্বয়ংক্রিয় কিউরেশন টুল ব্যবহার করেছেন?`,
    tr: `**VoteBroker'ı deneyin:** https://votebroker.org\n\nDüşüncelerinizi duymak isterim. Daha önce otomatik kürasyon araçları kullandınız mı?`,
    pl: `**Wypróbuj VoteBroker:** https://votebroker.org\n\nChętnie poznam Twoje zdanie. Czy wcześniej korzystałeś z automatycznych narzędzi do kuracji?`,
    pcm: `**Try VoteBroker:** https://votebroker.org\n\nI wan hear your thoughts. You don try automated curation tools before?`,
  };

  const cta = CTAS[locale] || CTAS.en;

  // Build draft title
  const TITLES: Record<string, string> = {
    en: "VoteBroker — Smarter Curation for the Steem Community",
    de: "VoteBroker — Intelligentere Kuration für die Steem-Community",
    es: "VoteBroker — Curación más inteligente para la comunidad Steem",
    pt: "VoteBroker — Curadoria mais inteligente para a comunidade Steem",
    id: "VoteBroker — Kurasi Lebih Cerdas untuk Komunitas Steem",
    ru: "VoteBroker — Умное кураторство для сообщества Steem",
    ko: "VoteBroker — Steem 커뮤니티를 위한 더 스마트한 큐레이션",
    zh: "VoteBroker — 为 Steem 社区提供更智能的策展",
    ja: "VoteBroker — Steemコミュニティのためのスマートなキュレーション",
    hi: "VoteBroker — Steem समुदाय के लिए स्मार्ट क्यूरेशन",
    bn: "VoteBroker — Steem সম্প্রদায়ের জন্য স্মার্ট কিউরেশন",
    tr: "VoteBroker — Steem Topluluğu için Daha Akıllı Kürasyon",
    pl: "VoteBroker — Mądrzejsza Kuracja dla Społeczności Steem",
    pcm: "VoteBroker — Better Curation for the Steem Community",
  };

  const title = TITLES[locale] || TITLES.en;

  const hasRealData = analysis.topAuthors.length > 0 && analysis.topTags.length > 0;
  const dataWarning = !hasRealData ? "\n⚠️ Wenig Daten gefunden — Text neutral gehalten." : "";

  // Build organic content with real scan data embedded naturally
  const realDataSection = hasRealData
    ? `\n\n---\n\n${getCommunityObservation(locale, analysis.trendingTopics, recommendation.tags[0] || locale, analysis.topAuthors[0] || "aktive Mitglieder")}`
    : "";

  const tagsLine = `**Tags:** ${recommendation.tags.map(t => `#${t}`).join(" ")}`;
  const communityLine = recommendation.community ? `**Community:** ${recommendation.community}` : "";
  const body = `${intro}\n\n---\n\n${core}${realDataSection}\n\n---\n\n${cta}\n\n---\n\n${communityLine ? communityLine + "\n" : ""}${tagsLine}`;

  // Analyse-Metadaten als YAML-Kommentar im Header — sichtbar im Preview, nicht im publizierten Text
  const analyseMeta = `<!--
ANALYSE (für Review — wird nicht veröffentlicht)
Sprache:    ${config.nativeName} (${locale})
Community:  ${recommendation.community || "keine eindeutige Community"}
Tags:       ${recommendation.tags.join(", ")}
Autoren:    ${analysis.topAuthors.slice(0, 5).join(", ") || "keine"}
Themen:     ${analysis.trendingTopics.slice(0, 3).join(" · ") || "keine"}
Stil:       ${styleProfile.tone} · ${styleProfile.avgLength} · Listen:${styleProfile.usesLists} · Bilder:${styleProfile.usesImages}
Posting:    ${recommendation.postingHour}:00 UTC
Begründung: ${recommendation.reasoning}${dataWarning}
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

*VoteBroker — Community Curation on Steem · [votebroker.org](https://votebroker.org)*
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
