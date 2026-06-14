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

---

## Phase 8: Curation Intelligence System 📋
*Strategie-Input von Michelangelo3, 2026-06-14*

**Kernthese:** VoteBroker entwickelt sich vom Vote-Manager zum Curation Intelligence System.
Die entscheidende Frage ist nicht "Wer hat wen gevoted?" sondern "Wo bekomme ich morgen die beste Rendite?"

**Zukünftige Navigation (langfristig):**
Dashboard · Vote DNA · Opportunities · CoPilot · Analytics

---

### Stufe 1: Top Opportunities 📋
*Voraussetzung: belastbarer Opportunity-Score*

Nicht: "Top-Autoren anzeigen"
Sondern: "Top Opportunities — beste Posts die gerade gevoted werden können"

| Feature | Status | Priorität |
|---------|--------|-----------|
| Composite Opportunity Score definieren | 📋 | **Hoch** |
| Growth Score | 📋 | Hoch |
| Signal Score | 📋 | Hoch |
| Timing Score | 📋 | Hoch (bereits teilweise vorhanden) |
| Discovery Score | 📋 | Mittel |
| Historische Validierung: Korrelation mit Curation-Rewards | 📋 | **Hoch** |
| `GET /api/me/opportunities` Endpoint | 📋 | Mittel |
| Opportunities View (UI) | 📋 | Mittel |

**Beispiel-Output:**
```
Autor    Score    Grund
user1    92       3 Signal-Kuratoren · frühe Phase
user2    87       Community-Wachstum
user3    84       Whale-Muster erkannt
```

**Wichtig:** Opportunity View erst bauen, wenn Score historisch validiert ist.
Ein Tab ohne belastbaren Score ist nur eine hübsche Liste.

---

### Stufe 2: Autoren-Ranking nach Curation-Rendite 📋
*Nicht nach Reputation oder Followern — nach historischem SP-Return*

| Feature | Status | Priorität |
|---------|--------|-----------|
| Growth-Analyse aus `vb_global_vote_outcomes` | 📋 | Hoch |
| SP-Rendite pro Autor (normiert auf VP) | 📋 | Hoch |
| Ranking: welche Autoren liefern regelmäßig gute Curation? | 📋 | Mittel |

**Beispiel:**
```
userA    +320%    ▲
userB    +280%    ▲
userC    +240%    ▲
```
(Rendite relativ zum Durchschnitt des Curators)

---

### Stufe 3: CoPilot — vollautonome Curation 📋
*Nutzer setzt nur Ziel-VP morgen + Max Votes. Rest läuft automatisch.*

| Feature | Status | Priorität |
|---------|--------|-----------|
| Vote-Weight-Optimizer | 📋 | **Hoch** |
| Scoring → Weight-Mapping: Score 96 → 35%, Score 88 → 25% | 📋 | Hoch |
| Opportunity-Score als CoPilot-Entscheidungsbasis | 📋 | Hoch |
| Autonomous execution (kein manueller Plan-Confirm) | 📋 | Mittel |

**Schlüsselunterschied zum Status quo:**
Nicht: 20 Posts × jeweils 10%
Sondern: Score A=96 → 35%, B=88 → 25%, C=84 → 20%, D=70 → 10%, E=62 → 10%

---

### Priorisierung der nächsten Entwicklungsschritte

1. **Opportunity-Score definieren** (Growth + Signal + Timing + Discovery)
2. **Historische Validierung** — `vb_global_vote_outcomes` auswerten: welche Faktoren korrelieren tatsächlich mit Curation-Rewards? Welche nur scheinbar?
3. **Vote-Weight-Optimizer vorbereiten** — Score-zu-Weight-Mapping aus realen Daten ableiten
4. **Dann:** Opportunities View bauen (UI)

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
