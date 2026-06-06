# VoteBroker – Produkt-Roadmap

**Letzte Aktualisierung:** 2026-06-06

---

## Legende

- ✅ implementiert
- 🔄 in Arbeit
- 📋 geplant
- 💡 Idee (nicht priorisiert)
- ❌ verworfen

---

## Phase 1: Core Infrastructure ✅

| Feature | Status | Datum |
|---------|--------|-------|
| Fastify API-Server | ✅ | – |
| SteemConnect OAuth (Login) | ✅ | – |
| Vote-Quote Engine (USD-basiert) | ✅ | – |
| Vote-Timing Score | ✅ | – |
| Fee-System (Billing, Consent) | ✅ | – |
| Operator-Dashboard | ✅ | – |
| Docker-Deployment (nginx + Caddy) | ✅ | – |
| SQLite Persistence (sessions, consents, strategy, authority_cache) | ✅ | 2026-05-31 |

---

## Phase 2: Vote-DNA & Strategy System ✅

| Feature | Status | Datum |
|---------|--------|-------|
| Vote-History Fetch (Steem API) | ✅ | – |
| CurationProfile Analyse | ✅ | – |
| DNA-Label Klassifikation (8 Typen) | ✅ | – |
| AuthorStats: avgWeightPct, compositeScore, lastVoteDaysAgo | ✅ | 2026-05-31 |
| Recency-gewichteter Composite-Score | ✅ | 2026-05-31 |
| Top-50 Autoren | ✅ | 2026-05-31 |
| DNA-Profil Badge (Emoji + Label) | ✅ | 2026-05-31 |
| Power-Stable Analyse | ✅ | 2026-05-31 |
| Strategy-Generator aus Vote-DNA | ✅ | 2026-05-31 |
| 6-stufiges Kategorie-System | ✅ | 2026-05-31 |
| Dynamische Budget-Allokation | ✅ | 2026-05-31 |
| Editierbarer Strategy-Editor | ✅ | 2026-05-31 |
| Manueller Author-Add | ✅ | 2026-05-31 |
| Community "Zur Strategie hinzufügen" | ✅ | 2026-05-31 |
| Strategy-Persistenz (SQLite + API) | ✅ | 2026-05-31 |
| Open Vote Opportunities | ✅ | 2026-05-31 |

---

## Phase 3: Login & Vertrauen ✅

| Feature | Status | Datum |
|---------|--------|-------|
| Auth-Bug: Active Key → Posting Key für Authority-Grant | ✅ | 2026-06-06 |
| Keychain Phase 1: Authority-Grant via requestAddAccountAuthority | ✅ | 2026-06-06 |
| Keychain Phase 2: Vote-Signing via requestBroadcast | ✅ | 2026-06-06 |
| Keychain Phase 3: Login via requestSignBuffer + Challenge-Response | ✅ | 2026-06-06 |
| SteemLogin als vollständiger Fallback | ✅ | 2026-06-06 |

---

## Phase 4: Onboarding & UX ✅

| Feature | Status | Datum |
|---------|--------|-------|
| Landingpage (vollständig, i18n, Screenshots, Branding) | ✅ | 2026-06-02 |
| i18n: 14 Sprachen (DE/EN/ES/KO/ZH/RU/PT/PCM/ID/HI/BN/JA/TR/PL) | ✅ | 2026-06-04 |
| DNA-Empty-State: führt aktiv zum Community-Tab weiter | ✅ | 2026-06-06 |
| Strategie-Editor unabhängig vom DNA-Ladezustand | ✅ | 2026-06-06 |
| Vote-History Regression Fix (Steem API start > limit) | ✅ | 2026-06-06 |
| Admin Cockpit: Pipeline-Dashboard, Archiv, Geplant-Tab | ✅ | 2026-06-05 |
| Promo-Post Pipeline (multilingual, 14 Sprachen) | ✅ | 2026-06-04 |

---

## Phase 5: Automation 📋

| Feature | Status | Priorität | Notizen |
|---------|--------|-----------|---------|
| Auto-Vote Queue aus Strategie generieren | 📋 | Hoch | Backend-Engine; "Immer voten"-Kategorie als Einstieg |
| Feed-Monitoring: Trigger wenn Lieblingsautor postet | 📋 | Hoch | erfordert Polling oder Webhook |
| "Immer voten" Kategorie: server-seitige Ausführung | 📋 | Hoch | benötigt Auto-Vote Queue |
| Scheduled DNA-Refresh (täglich automatisch) | 📋 | Mittel | Cron-Job |
| Webhook/Trigger: neuer Post von Lieblingsautor | 📋 | Mittel | |

---

## Phase 6: Intelligence 📋

| Feature | Status | Priorität | Notizen |
|---------|--------|-----------|---------|
| Timing-Analyse: `vb_global_vote_outcomes` wächst täglich | 🔄 | Hoch | Daten vorhanden, Auswertung ausstehend |
| Per-Author ROI: welche Autoren bringen meisten Curation SP | 📋 | Mittel | |
| Tag-basiertes Filtering | 📋 | Mittel | nur Autoren mit bestimmten Tags |
| Consistency-Score in AuthorStats | 📋 | Niedrig | |
| VP-Prognose über 7 Tage | 📋 | Niedrig | |

---

## Phase 7: Community & Monetarisierung 💡

| Feature | Status | Priorität | Notizen |
|---------|--------|-----------|---------|
| Community Spotlight | 📋 | Mittel | bezahlte Sichtbarkeit für Autoren, strikt getrennt von organischen Empfehlungen |
| Strategy-Templates | 💡 | Niedrig | vordefinierte Starter-Strategien |
| Strategy-Export / Import (JSON) | 📋 | Niedrig | |
| Multi-Account | 💡 | Niedrig | mehrere Accounts unter einem Login |

---

## Verworfen

| Feature | Grund |
|---------|-------|
| Community Pools | zu komplex, kein klarer Mehrwert gegenüber individueller Strategie |

---

## Technische Schulden

| Item | Priorität | Notizen |
|------|-----------|---------|
| App.tsx (~2200 Zeilen) | Mittel | Aufteilen in Modul-Dateien überfällig |
| Keine Unit-Tests für curationDna.ts | Mittel | compositeScore, selectionReasons |
| Deploy-Prozess: manuell via docker cp | Mittel | kein CI/CD |
| Keychain Mobile-Kompatibilität | Mittel | @kafio's mobile Version testen sobald stabil |
| Strategy-Simulation: linearisiertes VP-Modell | Niedrig | Näherung, keine echte VP-Physik |
