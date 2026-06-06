// ── SettingsView — Consent, Authority, Timezone settings ─────────────────────
// Extracted from App.tsx — ConsentPanel, AuthorityPanel, AuthBar, TimezoneSettings

import React, { useState, useEffect } from "react";
import { AlertTriangle, CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import { createTranslator, locales, type Locale } from "../i18n";
import type { AuthSession, ConsentRecord, ConsentState, ConsentType } from "../api";

// ── Consent Center metadata ───────────────────────────────────────────────────

export function getConsentMeta(t: ReturnType<typeof createTranslator>): Record<ConsentType, {
  icon: string; label: string; description: string; note: string; required: boolean;
}> {
  return {
    login:                { icon: "🔐", label: t("consentLabelLogin"),      description: t("consentDescLogin"),      note: t("consentNoteLogin"),      required: true  },
    target_vote:          { icon: "📊", label: t("consentLabelTargetVote"), description: t("consentDescTargetVote"), note: t("consentNoteTargetVote"), required: false },
    auto_vote:            { icon: "🤖", label: t("consentLabelAutoVote"),   description: t("consentDescAutoVote"),   note: t("consentNoteAutoVote"),   required: false },
    fee_post_vote:        { icon: "💰", label: t("consentLabelFeePost"),    description: t("consentDescFeePost"),    note: t("consentNoteFeePost"),    required: false },
    ai_strategy:          { icon: "🧬", label: t("consentLabelAiStrategy"), description: t("consentDescAiStrategy"), note: t("consentNoteAiStrategy"), required: false },
    community_intelligence:{ icon: "👥",label: t("consentLabelCommunity"), description: t("consentDescCommunity"),  note: t("consentNoteCommunity"),  required: false },
  };
}

// Ordered display
export const CONSENT_ORDER: ConsentType[] = ["login", "target_vote", "auto_vote", "fee_post_vote", "ai_strategy", "community_intelligence"];

export function ConsentPanel(props: {
  catalog: ConsentRecord[];
  consentError: string | null;
  loadingType: ConsentType | null;
  onGrant: (type: ConsentType) => void;
  onRevoke: (type: ConsentType) => void;
  session: AuthSession | null;
  state: ConsentState | null;
  t: ReturnType<typeof createTranslator>;
  locale?: import("../i18n").Locale;
}) {
  const activeTypes = new Set(props.state?.active.map((r) => r.type) ?? []);
  const history = props.state?.history.filter(r => r.status === "revoked").slice(0, 5) ?? [];
  const [historyOpen, setHistoryOpen] = React.useState(false);

  const panelStyle: React.CSSProperties = {
    marginBottom: "1rem"
  };

  return (
    <div>
      {/* Header */}
      <div style={{ ...panelStyle, marginBottom: "0.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <ShieldCheck size={18} style={{ color: "#2563eb" }} />
            <span style={{ color: "#17202a", fontWeight: 700, fontSize: "1rem" }}>{props.t("settingsPermissions")}</span>
          </div>
          <span style={{ color: "#607078", fontSize: "0.78rem" }}>
            {props.t("settingsActiveOf").replace("{{n}}", String(activeTypes.size)).replace("{{total}}", String(CONSENT_ORDER.length))}
          </span>
        </div>
        <p style={{ color: "#607078", fontSize: "0.82rem", margin: 0 }}>
          {props.t("consentControlNote")}
        </p>
      </div>

      {props.consentError && (
        <div style={{ background: "#3d0e0e", border: "1px solid #f85149", borderRadius: "6px", padding: "0.6rem 0.75rem", marginBottom: "0.75rem", color: "#dc2626", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <AlertTriangle size={14} />
          {props.consentError}
        </div>
      )}

      {/* Consent list */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        {CONSENT_ORDER.map(type => {
          const meta    = getConsentMeta(props.t)[type];
          const active  = activeTypes.has(type);
          const loading = props.loadingType === type;
          const disabled = !props.session || loading;
          const catalog = props.catalog.find(r => r.type === type);

          return (
            <div
              key={type}
              style={{
                background: "#f0f5f7",
                border: `1px solid ${active ? "#dde8ed" : "#dde8ed"}`,
                borderLeft: `3px solid ${active ? "#16a34a" : "#c5d3da"}`,
                borderRadius: "6px",
                padding: "0.85rem 1rem",
                display: "flex",
                alignItems: "flex-start",
                gap: "0.85rem",
                opacity: disabled && !meta.required ? 0.7 : 1,
              }}
            >
              {/* Type icon */}
              <div style={{ fontSize: "1.2rem", lineHeight: 1, marginTop: "0.1rem", flexShrink: 0 }}>
                {meta.icon}
              </div>

              {/* Content */}
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.2rem" }}>
                  <span style={{ color: "#17202a", fontWeight: 600, fontSize: "0.9rem" }}>{meta.label}</span>
                  {meta.required && (
                    <span style={{ background: "#1b4332", color: "#16a34a", border: "1px solid #3fb95055", borderRadius: "4px", padding: "0.05rem 0.4rem", fontSize: "0.68rem", fontWeight: 600 }}>
                      {props.t("confirm")}
                    </span>
                  )}
                  {!active && !meta.required && (
                    <span style={{ color: "#8fa4b0", fontSize: "0.72rem" }}>{props.t("statusInactive")}</span>
                  )}
                </div>
                <p style={{ color: "#607078", fontSize: "0.8rem", margin: "0 0 0.2rem", lineHeight: 1.4 }}>
                  {meta.description}
                </p>
                <p style={{ color: "#8fa4b0", fontSize: "0.73rem", margin: 0, fontStyle: "italic" }}>
                  {meta.note}
                </p>
              </div>

              {/* Status pill — same style as AuthorityPanel (.status-pill) */}
              <div style={{ flexShrink: 0 }}>
                {meta.required ? (
                  /* System consent — locked ON, non-interactive */
                  <div style={{
                    display: "inline-flex", alignItems: "center", gap: "6px",
                    background: "#0f2318", border: "1px solid #16a34a44",
                    borderRadius: "999px", padding: "6px 12px",
                    color: "#4ade80", fontWeight: 700, fontSize: "0.78rem",
                    cursor: "not-allowed", opacity: 0.85,
                  }}>
                    <CheckCircle2 size={14} />
                    Aktiv
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => active ? props.onRevoke(type) : props.onGrant(type)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "6px",
                      background: loading
                        ? "#1e2733"
                        : active  ? "#0f2318" : "#1a1f25",
                      border: `1px solid ${loading ? "#607078" : active ? "#16a34a55" : "#374151"}`,
                      borderRadius: "999px",
                      padding: "6px 12px",
                      color: loading ? "#9ca3af" : active ? "#4ade80" : "#9ca3af",
                      fontWeight: 700, fontSize: "0.78rem",
                      cursor: disabled ? "not-allowed" : "pointer",
                      transition: "background 0.15s, border-color 0.15s, color 0.15s",
                      outline: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {loading ? (
                      <span style={{ display: "inline-block", width: "14px", height: "14px",
                        border: "2px solid #607078", borderTopColor: "transparent",
                        borderRadius: "50%", animation: "spin 0.7s linear infinite" }}/>
                    ) : active ? (
                      <CheckCircle2 size={14} />
                    ) : (
                      <Circle size={14} />
                    )}
                    {loading ? props.t("statusLoading") : active ? props.t("statusActive") : props.t("statusInactive")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent revocations — collapsed by default */}
      {history.length > 0 && (
        <div style={{ marginTop: "1rem", border: "1px solid #21262d", borderRadius: "6px", overflow: "hidden" }}>
          <button
            type="button"
            onClick={() => setHistoryOpen(o => !o)}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
              background: "#ffffff", border: "none", cursor: "pointer",
              padding: "0.6rem 1rem", textAlign: "left",
            }}
          >
            <span style={{ color: "#607078", fontSize: "0.73rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 600 }}>
              {props.t("consentHistoryTitle")} ({history.length})
            </span>
            <span style={{ color: "#607078", fontSize: "0.8rem", transition: "transform 0.2s", display: "inline-block", transform: historyOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▾</span>
          </button>
          {historyOpen && (
            <div style={{ padding: "0.5rem 1rem 0.75rem", background: "#ffffff", borderTop: "1px solid #f0f0f0" }}>
              {history.map(record => (
                <div key={record.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.78rem", color: "#607078", marginBottom: "0.2rem" }}>
                  <span style={{ color: record.status === "granted" ? "#16a34a" : "#dc2626" }}>
                    {record.status === "granted" ? props.t("consentStatusGranted") : props.t("consentStatusRevoked")}
                  </span>
                  <span>{getConsentMeta(props.t)[record.type as ConsentType]?.label ?? record.title}</span>
                  <span style={{ color: "#8fa4b0" }}>
                    {new Date(record.revokedAt ?? record.createdAt ?? "").toLocaleDateString(props.locale ?? "de")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AuthBar(props: {
  authError: string | null;
  authLoading: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  session: AuthSession | null;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <section className="auth-bar">
      <div>
        <span>{props.t("steemConnect")}</span>
        <strong>
          {props.session ? `@${props.session.user.username} ${props.t("connected")}` : props.t("nonCustodialLogin")}
        </strong>
      </div>
      {props.authError && (
        <div className="auth-error">
          <AlertTriangle size={15} />
          {props.authError}
        </div>
      )}
      {props.session ? (
        <button className="secondary-button" type="button" onClick={props.onDisconnect}>
          {props.t("signout")}
        </button>
      ) : (
        <button className="secondary-button" disabled={props.authLoading} type="button" onClick={props.onConnect}>
          <ShieldCheck size={16} />
          {props.authLoading ? props.t("connecting") : props.t("connect")}
        </button>
      )}
    </section>
  );
}

// ── Timezone list — curated IANA names with friendly labels ──────────────────

// Timezone labels per locale — value (IANA ID) stays unchanged, only the display label changes.
// Abbreviations (MEZ, JST, KST, …) are internationally recognized and stay in all languages.
const TIMEZONE_LABELS: Record<string, Record<string, string>> = {
  "Europe/Berlin":      { de: "Berlin (MEZ/MESZ)",      en: "Berlin (CET/CEST)",    es: "Berlín (CET/CEST)",     ko: "베를린 (CET/CEST)",    zh: "柏林 (CET/CEST)",      ru: "Берлин (CET/CEST)"      , pcm: "Berlin (CET/CEST)", pl: "Berlin (CET/CEST)", tr: "Berlin (CET/CEST)", ja: "ベルリン (CET/CEST)", bn: "বার্লিন (CET/CEST)", hi: "बर्लिन (CET/CEST)", id: "Berlin (CET/CEST)", pt: "Berlim (CET/CEST)"      },
  "Europe/London":      { de: "London (GMT/BST)",        en: "London (GMT/BST)",     es: "Londres (GMT/BST)",     ko: "런던 (GMT/BST)",       zh: "伦敦 (GMT/BST)",        ru: "Лондон (GMT/BST)"       , pcm: "London (GMT/BST)", pl: "Londyn (GMT/BST)", tr: "Londra (GMT/BST)", ja: "ロンドン (GMT/BST)", bn: "লন্ডন (GMT/BST)", hi: "लंदन (GMT/BST)", id: "London (GMT/BST)", pt: "Londres (GMT/BST)"      },
  "Europe/Paris":       { de: "Paris (MEZ/MESZ)",        en: "Paris (CET/CEST)",     es: "París (CET/CEST)",      ko: "파리 (CET/CEST)",      zh: "巴黎 (CET/CEST)",       ru: "Париж (CET/CEST)"       , pcm: "Paris (CET/CEST)", pl: "Paryż (CET/CEST)", tr: "Paris (CET/CEST)", ja: "パリ (CET/CEST)", bn: "প্যারিস (CET/CEST)", hi: "पेरिस (CET/CEST)", id: "Paris (CET/CEST)", pt: "Paris (CET/CEST)"      },
  "Europe/Vienna":      { de: "Wien (MEZ/MESZ)",         en: "Vienna (CET/CEST)",    es: "Viena (CET/CEST)",      ko: "빈 (CET/CEST)",        zh: "维也纳 (CET/CEST)",     ru: "Вена (CET/CEST)"        , pcm: "Vienna (CET/CEST)", pl: "Wiedeń (CET/CEST)", tr: "Viyana (CET/CEST)", ja: "ウィーン (CET/CEST)", bn: "ভিয়েনা (CET/CEST)", hi: "वियना (CET/CEST)", id: "Wina (CET/CEST)", pt: "Viena (CET/CEST)"      },
  "Europe/Zurich":      { de: "Zürich (MEZ/MESZ)",       en: "Zurich (CET/CEST)",    es: "Zúrich (CET/CEST)",     ko: "취리히 (CET/CEST)",    zh: "苏黎世 (CET/CEST)",     ru: "Цюрих (CET/CEST)"       , pcm: "Zurich (CET/CEST)", pl: "Zurych (CET/CEST)", tr: "Zürih (CET/CEST)", ja: "チューリッヒ (CET/CEST)", bn: "জুরিখ (CET/CEST)", hi: "ज़्यूरिख़ (CET/CEST)", id: "Zurich (CET/CEST)", pt: "Zurique (CET/CEST)"      },
  "Europe/Amsterdam":   { de: "Amsterdam (MEZ/MESZ)",    en: "Amsterdam (CET/CEST)", es: "Ámsterdam (CET/CEST)",  ko: "암스테르담 (CET/CEST)", zh: "阿姆斯特丹 (CET/CEST)", ru: "Амстердам (CET/CEST)"   , pcm: "Amsterdam (CET/CEST)", pl: "Amsterdam (CET/CEST)", tr: "Amsterdam (CET/CEST)", ja: "アムステルダム (CET/CEST)", bn: "আমস্টারডাম (CET/CEST)", hi: "एम्स्टर्डम (CET/CEST)", id: "Amsterdam (CET/CEST)", pt: "Amsterdã (CET/CEST)"      },
  "Europe/Warsaw":      { de: "Warschau (MEZ/MESZ)",     en: "Warsaw (CET/CEST)",    es: "Varsovia (CET/CEST)",   ko: "바르샤바 (CET/CEST)",  zh: "华沙 (CET/CEST)",       ru: "Варшава (CET/CEST)"      , pcm: "Warsaw (CET/CEST)", pl: "Warszawa (CET/CEST)", tr: "Varşova (CET/CEST)", ja: "ワルシャワ (CET/CEST)", bn: "ওয়ারশ (CET/CEST)", hi: "वारसॉ (CET/CEST)", id: "Warsawa (CET/CEST)", pt: "Varsóvia (CET/CEST)"      },
  "Europe/Stockholm":   { de: "Stockholm (MEZ/MESZ)",    en: "Stockholm (CET/CEST)", es: "Estocolmo (CET/CEST)",  ko: "스톡홀름 (CET/CEST)",  zh: "斯德哥尔摩 (CET/CEST)", ru: "Стокгольм (CET/CEST)"   , pcm: "Stockholm (CET/CEST)", pl: "Sztokholm (CET/CEST)", tr: "Stockholm (CET/CEST)", ja: "ストックホルム (CET/CEST)", bn: "স্টকহোম (CET/CEST)", hi: "स्टॉकहोम (CET/CEST)", id: "Stockholm (CET/CEST)", pt: "Estocolmo (CET/CEST)"      },
  "Europe/Moscow":      { de: "Moskau (MSK)",            en: "Moscow (MSK)",         es: "Moscú (MSK)",           ko: "모스크바 (MSK)",       zh: "莫斯科 (MSK)",          ru: "Москва (MSK)"            , pcm: "Moscow (MSK)", pl: "Moskwa (MSK)", tr: "Moskova (MSK)", ja: "モスクワ (MSK)", bn: "মস্কো (MSK)", hi: "मॉस्को (MSK)", id: "Moskow (MSK)", pt: "Moscou (MSK)"      },
  "Asia/Dubai":         { de: "Dubai (GST)",             en: "Dubai (GST)",          es: "Dubái (GST)",           ko: "두바이 (GST)",         zh: "迪拜 (GST)",             ru: "Дубай (GST)"             , pcm: "Dubai (GST)", pl: "Dubaj (GST)", tr: "Dubai (GST)", ja: "ドバイ (GST)", bn: "দুবাই (GST)", hi: "दुबई (GST)", id: "Dubai (GST)", pt: "Dubai (GST)"      },
  "Asia/Kolkata":       { de: "Kolkata (IST)",           en: "Kolkata (IST)",        es: "Calcuta (IST)",         ko: "콜카타 (IST)",         zh: "加尔各答 (IST)",         ru: "Калькутта (IST)"         , pcm: "Kolkata (IST)", pl: "Kalkuta (IST)", tr: "Kalkuta (IST)", ja: "コルカタ (IST)", bn: "কলকাতা (IST)", hi: "कोलकाता (IST)", id: "Kolkata (IST)", pt: "Calcutá (IST)"      },
  "Asia/Singapore":     { de: "Singapur (SGT)",          en: "Singapore (SGT)",      es: "Singapur (SGT)",        ko: "싱가포르 (SGT)",       zh: "新加坡 (SGT)",           ru: "Сингапур (SGT)"          , pcm: "Singapore (SGT)", pl: "Singapur (SGT)", tr: "Singapur (SGT)", ja: "シンガポール (SGT)", bn: "সিঙ্গাপুর (SGT)", hi: "सिंगापुर (SGT)", id: "Singapura (SGT)", pt: "Singapura (SGT)"      },
  "Asia/Tokyo":         { de: "Tokio (JST)",             en: "Tokyo (JST)",          es: "Tokio (JST)",           ko: "도쿄 (JST)",           zh: "东京 (JST)",             ru: "Токио (JST)"             , pcm: "Tokyo (JST)", pl: "Tokio (JST)", tr: "Tokyo (JST)", ja: "東京 (JST)", bn: "টোকিও (JST)", hi: "टोक्यो (JST)", id: "Tokyo (JST)", pt: "Tóquio (JST)"      },
  "Asia/Seoul":         { de: "Seoul (KST)",             en: "Seoul (KST)",          es: "Seúl (KST)",            ko: "서울 (KST)",           zh: "首尔 (KST)",             ru: "Сеул (KST)"              , pcm: "Seoul (KST)", pl: "Seul (KST)", tr: "Seul (KST)", ja: "ソウル (KST)", bn: "সিউল (KST)", hi: "सियोल (KST)", id: "Seoul (KST)", pt: "Seul (KST)"      },
  "Asia/Shanghai":      { de: "Shanghai (CST)",          en: "Shanghai (CST)",       es: "Shanghái (CST)",        ko: "상하이 (CST)",         zh: "上海 (CST)",             ru: "Шанхай (CST)"            , pcm: "Shanghai (CST)", pl: "Szanghaj (CST)", tr: "Shangay (CST)", ja: "上海 (CST)", bn: "সাংহাই (CST)", hi: "शंघाई (CST)", id: "Shanghai (CST)", pt: "Xangai (CST)"      },
  "Australia/Sydney":   { de: "Sydney (AEST/AEDT)",      en: "Sydney (AEST/AEDT)",   es: "Sídney (AEST/AEDT)",    ko: "시드니 (AEST/AEDT)",   zh: "悉尼 (AEST/AEDT)",      ru: "Сидней (AEST/AEDT)"      , pcm: "Sydney (AEST/AEDT)", pl: "Sydney (AEST/AEDT)", tr: "Sidney (AEST/AEDT)", ja: "シドニー (AEST/AEDT)", bn: "সিডনি (AEST/AEDT)", hi: "सिडनी (AEST/AEDT)", id: "Sydney (AEST/AEDT)", pt: "Sydney (AEST/AEDT)"      },
  "Pacific/Auckland":   { de: "Auckland (NZST/NZDT)",    en: "Auckland (NZST/NZDT)", es: "Auckland (NZST/NZDT)",  ko: "오클랜드 (NZST/NZDT)", zh: "奥克兰 (NZST/NZDT)",   ru: "Окленд (NZST/NZDT)"     , pcm: "Auckland (NZST/NZDT)", pl: "Auckland (NZST/NZDT)", tr: "Auckland (NZST/NZDT)", ja: "オークランド (NZST/NZDT)", bn: "অকল্যান্ড (NZST/NZDT)", hi: "ऑकलैंड (NZST/NZDT)", id: "Auckland (NZST/NZDT)", pt: "Auckland (NZST/NZDT)"      },
  "UTC":                { de: "UTC / Greenwich",         en: "UTC / Greenwich",      es: "UTC / Greenwich",       ko: "UTC / 그리니치",       zh: "UTC / 格林尼治",         ru: "UTC / Гринвич"           , pcm: "UTC / Greenwich", pl: "UTC / Greenwich", tr: "UTC / Greenwich", ja: "UTC / グリニッジ", bn: "UTC / Greenwich", hi: "UTC / Greenwich", id: "UTC / Greenwich", pt: "UTC / Greenwich"      },
  "America/Sao_Paulo":  { de: "São Paulo (BRT)",         en: "São Paulo (BRT)",      es: "São Paulo (BRT)",       ko: "상파울루 (BRT)",       zh: "圣保罗 (BRT)",           ru: "Сан-Паулу (BRT)"         , pcm: "São Paulo (BRT)", pl: "Sao Paulo (BRT)", tr: "Sao Paulo (BRT)", ja: "サンパウロ (BRT)", bn: "সাও পাওলো (BRT)", hi: "साओ पाउलो (BRT)", id: "Sao Paulo (BRT)", pt: "São Paulo (BRT)"      },
  "America/New_York":   { de: "New York (ET)",           en: "New York (ET)",        es: "Nueva York (ET)",       ko: "뉴욕 (ET)",            zh: "纽约 (ET)",              ru: "Нью-Йорк (ET)"           , pcm: "New York (ET)", pl: "Nowy Jork (ET)", tr: "New York (ET)", ja: "ニューヨーク (ET)", bn: "নিউ ইয়র্ক (ET)", hi: "न्यूयॉर्क (ET)", id: "New York (ET)", pt: "Nova York (ET)"      },
  "America/Chicago":    { de: "Chicago (CT)",            en: "Chicago (CT)",         es: "Chicago (CT)",          ko: "시카고 (CT)",          zh: "芝加哥 (CT)",            ru: "Чикаго (CT)"             , pcm: "Chicago (CT)", pl: "Chicago (CT)", tr: "Chicago (CT)", ja: "シカゴ (CT)", bn: "শিকাগো (CT)", hi: "शिकागो (CT)", id: "Chicago (CT)", pt: "Chicago (CT)"      },
  "America/Denver":     { de: "Denver (MT)",             en: "Denver (MT)",          es: "Denver (MT)",           ko: "덴버 (MT)",            zh: "丹佛 (MT)",              ru: "Денвер (MT)"             , pcm: "Denver (MT)", pl: "Denver (MT)", tr: "Denver (MT)", ja: "デンバー (MT)", bn: "ডেনভার (MT)", hi: "डेनवर (MT)", id: "Denver (MT)", pt: "Denver (MT)"      },
  "America/Los_Angeles":{ de: "Los Angeles (PT)",        en: "Los Angeles (PT)",     es: "Los Ángeles (PT)",      ko: "로스앤젤레스 (PT)",    zh: "洛杉矶 (PT)",            ru: "Лос-Анджелес (PT)"       , pcm: "Los Angeles (PT)", pl: "Los Angeles (PT)", tr: "Los Angeles (PT)", ja: "ロサンゼルス (PT)", bn: "লস অ্যাঞ্জেলেস (PT)", hi: "लॉस एंजिल्स (PT)", id: "Los Angeles (PT)", pt: "Los Angeles (PT)"      },
};

export function getTimezones(locale: string): Array<{ value: string; label: string }> {
  return Object.entries(TIMEZONE_LABELS).map(([value, labels]) => ({
    value,
    label: labels[locale] ?? labels.en ?? value,
  }));
}

export function TimezoneSettings({ locale, timezone, onLocaleChange, onTimezoneChange, t }: {
  locale: Locale;
  timezone: string;
  onLocaleChange: (l: Locale) => void;
  onTimezoneChange: (tz: string) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const localTime = now.toLocaleTimeString(locale === "de" ? "de-DE" : "en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const localDate = now.toLocaleDateString(locale === "de" ? "de-DE" : "en-GB", {
    timeZone: timezone, weekday: "long", day: "numeric", month: "long",
  });

  // Build locale-aware timezone list; add browser TZ if not in list
  const tzList  = getTimezones(locale);
  const inList  = tzList.some(z => z.value === timezone);
  const options = inList
    ? tzList
    : [{ value: timezone, label: `${timezone} (Browser)` }, ...tzList];

  const panelStyle: React.CSSProperties = {
    background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: "12px",
    padding: "1.25rem 1.5rem", marginBottom: "1rem",
  };
  const lbl: React.CSSProperties = {
    fontSize: "0.75rem", fontWeight: 600, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "0.5rem",
  };
  const sel: React.CSSProperties = {
    background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: "8px",
    color: "#111827", cursor: "pointer", fontSize: "0.88rem",
    padding: "0.5rem 0.75rem", width: "100%",
  };

  return (
    <div style={{ maxWidth: "520px", padding: "1.25rem 1.5rem" }}>
      <h2 style={{ fontSize: "1rem", fontWeight: 700, color: "#111827", margin: "0 0 1.25rem" }}>
        {t("settingsTitle")}
      </h2>

      {/* Sprache */}
      <div style={panelStyle}>
        <p style={lbl}>{t("settingsLanguage")}</p>
        <select style={sel} value={locale}
          onChange={e => onLocaleChange(e.target.value as Locale)}>
          {locales.map(l => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </div>

      {/* Zeitzone */}
      <div style={panelStyle}>
        <p style={lbl}>{t("settingsTimezone")}</p>
        <select style={sel} value={timezone}
          onChange={e => onTimezoneChange(e.target.value)}>
          {options.map(z => (
            <option key={z.value} value={z.value}>{z.label}</option>
          ))}
        </select>

        {/* Live-Uhr */}
        <div style={{
          marginTop: "0.85rem", background: "#f0fdf4", border: "1px solid #bbf7d0",
          borderRadius: "8px", padding: "0.65rem 0.9rem",
          display: "flex", alignItems: "center", gap: "0.75rem",
        }}>
          <span style={{ fontSize: "1.2rem" }}>🕒</span>
          <div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800, color: "#15803d",
              letterSpacing: "-0.5px", fontVariantNumeric: "tabular-nums" }}>
              {localTime}
            </div>
            <div style={{ fontSize: "0.73rem", color: "#6b7280", marginTop: "0.1rem" }}>
              {localDate} · {timezone}
            </div>
          </div>
        </div>

        <p style={{ fontSize: "0.72rem", color: "#9ca3af", margin: "0.6rem 0 0" }}>
          {t("settingsTimezoneNote")}
        </p>
      </div>
    </div>
  );
}

export function AuthorityPanel(props: {
  grantUrl: string;
  hasAuthority: boolean | null;
  session: AuthSession | null;
  locale?: import("../i18n").Locale;
  keychainAvailable?: boolean | null;
  onKeychainGrant?: () => void;
}) {
  const t = createTranslator(props.locale ?? "de");
  const [keychainPending, setKeychainPending] = useState(false);
  const [keychainError, setKeychainError] = useState<string | null>(null);

  if (!props.session) return null;

  const handleKeychainGrant = () => {
    if (!props.session || !window.steem_keychain) return;
    setKeychainPending(true);
    setKeychainError(null);
    window.steem_keychain.requestAddAccountAuthority(
      props.session.user.username,
      "votebroker",
      "Posting",
      1,
      (resp) => {
        setKeychainPending(false);
        if (resp.success) {
          props.onKeychainGrant?.();
        } else {
          setKeychainError(resp.error ?? resp.message ?? "Keychain error");
        }
      }
    );
  };

  const useKeychain = props.keychainAvailable === true;

  return (
    <section className="auth-bar">
      <div>
        <span>{t("authorityTitle")}</span>
        <strong>
          {props.hasAuthority === null && t("authorityChecking")}
          {props.hasAuthority === true && t("authorityGranted")}
          {props.hasAuthority === false && (keychainPending ? t("authorityKeychainPending") : t("authorityMissing"))}
        </strong>
        {props.hasAuthority === false && !keychainPending && (
          <small style={{ display: "block", marginTop: "0.25rem", color: "#888", fontSize: "0.78rem" }}>
            {t("authorityNote")}
            {useKeychain && (
              <span style={{ marginLeft: "0.5rem", color: "#16a34a" }}>✓ {t("authorityActiveKeyHint")}</span>
            )}
          </small>
        )}
        {keychainError && (
          <small style={{ display: "block", marginTop: "0.25rem", color: "#dc2626", fontSize: "0.78rem" }}>
            {t("authorityKeychainError").replace("{{error}}", keychainError)}
          </small>
        )}
      </div>
      {props.hasAuthority === false && (
        useKeychain
          ? <button
              type="button"
              onClick={handleKeychainGrant}
              disabled={keychainPending}
              className="secondary-button"
              style={{ opacity: keychainPending ? 0.6 : 1, cursor: keychainPending ? "wait" : "pointer" }}
            >
              <ShieldCheck size={16} />
              {keychainPending ? t("authorityKeychainPending") : t("authorityGrantKeychain")}
            </button>
          : props.grantUrl && (
              <a className="secondary-button" href={props.grantUrl}>
                <ShieldCheck size={16} />
                {t("authorityGrantSteemlogin")}
              </a>
            )
      )}
      {props.hasAuthority === true && (
        <div className="status-pill">
          <CheckCircle2 size={16} />
          {t("authorityGranted").includes("✓") ? "Aktiv" : t("authorityGranted")}
        </div>
      )}
    </section>
  );
}
