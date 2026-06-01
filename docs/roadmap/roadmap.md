# VoteBroker – Produkt-Roadmap

**Letzte Aktualisierung:** 2026-05-31

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
| SteemConnect OAuth | ✅ | – |
| Vote-Quote Engine (USD-basiert) | ✅ | – |
| Vote-Timing Score | ✅ | – |
| Fee-System (Billing, Consent) | ✅ | – |
| Operator-Dashboard | ✅ | – |
| Community Pool | ✅ | – |
| Docker-Deployment (nginx + Caddy) | ✅ | – |

---

## Phase 2: Vote-DNA & Strategy System ✅

| Feature | Status | Datum |
|---------|--------|-------|
| Vote-History Fetch (Steem API) | ✅ | – |
| CurationProfile Analyse | ✅ | – |
| DNA-Label Klassifikation (8 Typen) | ✅ | – |
| AuthorStats: avgWeightPct, compositeScore | ✅ | 2026-05-31 |
| AuthorStats: lastVoteDaysAgo, selectionReasons | ✅ | 2026-05-31 |
| Recency-gewichteter Composite-Score | ✅ | 2026-05-31 |
| Top-50 Autoren (war: Top-15) | ✅ | 2026-05-31 |
| DNA-Profil Badge (Emoji + Label) | ✅ | 2026-05-31 |
| Power-Stable Analyse (erklärender Kasten) | ✅ | 2026-05-31 |
| Strategy-Generator aus Vote-DNA | ✅ | 2026-05-31 |
| 6-stufiges Kategorie-System | ✅ | 2026-05-31 |
| Dynamische Budget-Allokation | ✅ | 2026-05-31 |
| Editierbarer Strategy-Editor (Tabelle) | ✅ | 2026-05-31 |
| Expandable Row mit Auswahlgründen | ✅ | 2026-05-31 |
| Strategy-Simulation Panel | ✅ | 2026-05-31 |
| Manueller Author-Add | ✅ | 2026-05-31 |
| Community "Zur Strategie hinzufügen" | ✅ | 2026-05-31 |
| localStorage-Persistenz | ✅ | 2026-05-31 |
| Bugfix: API URL (relative statt localhost) | ✅ | 2026-05-31 |
| Bugfix: Fehlerbehandlung getCurationDna | ✅ | 2026-05-31 |

---

## Phase 3: Strategy Persistence & Execution 📋

| Feature | Status | Priorität | Notizen |
|---------|--------|-----------|---------|
| `POST /api/strategy` — Strategie speichern | ✅ | Hoch | SQLite-backed, 2026-05-31 |
| `GET /api/strategy` — Strategie laden | ✅ | Hoch | mit Hydration-Guard, 2026-05-31 |
| SQLite Persistence Layer | ✅ | Kritisch | sessions, consents, strategy, authority_cache, 2026-05-31 — **SMOKE TEST PASSED 4/4** |
| Merge: neue DNA + bestehende manuelle Regeln | 📋 | Mittel | `manuallyModified` Flag bereits vorhanden |
| Strategy-Export (JSON-Download) | 📋 | Niedrig | Browser-API |
| Strategy-Import (JSON-Upload) | 📋 | Niedrig | |
| Auto-Vote Queue aus Strategy generieren | 📋 | Hoch | Backend-Engine |
| Open Vote Opportunities (Post-Check + Vote-Action) | ✅ | Hoch | `POST /api/curation/opportunities`, 2026-05-31 |
| Webhook/Trigger: neuer Post von Lieblingsautor | 📋 | Hoch | erfordert Feed-Monitoring |
| "Immer voten" Kategorie: Server-seitige Ausführung | 📋 | Hoch | |

---

## Phase 4: Intelligence & Automation 📋

| Feature | Status | Priorität | Notizen |
|---------|--------|-----------|---------|
| Scheduled DNA-Refresh (täglich automatisch) | 📋 | Mittel | Cron-Job oder Polling |
| Consistency-Score in AuthorStats | 📋 | Niedrig | Gleichmäßigkeit über Periode |
| Tag-basiertes Filtering | 📋 | Mittel | nur Autoren mit bestimmten Tags |
| Community-spezifische Gewichtung | 📋 | Mittel | |
| Engagement-Score (Curation-Reward basiert) | 💡 | Niedrig | komplex |
| VP-Prognose über 7 Tage (Chart) | 📋 | Niedrig | Simulation-Erweiterung |
| Strategie-Vergleich (vorher/nachher) | 💡 | Niedrig | |

---

## Phase 5: Multi-Account & Community Features 💡

| Feature | Status | Priorität | Notizen |
|---------|--------|-----------|---------|
| Multi-Account Strategy | 💡 | Niedrig | mehrere Accounts unter einem Login |
| Shared Pool Strategy | 💡 | Niedrig | Community-Mitglieder teilen Strategie |
| Strategy-Templates | 💡 | Niedrig | vordefinierte Starter-Strategien |

---

## Technische Schulden

| Item | Priorität | Notizen |
|------|-----------|---------|
| `VITE_API_BASE` in `apps/web/.env` statt Monorepo-Root | Niedrig | oder Default-Wert "" dokumentieren |
| App.tsx Größe (~1600 Zeilen) | Mittel | Aufteilen in Modul-Dateien |
| Keine Tests für curationDna.ts | Mittel | Unit-Tests für compositeScore, selectionReasons |
| Strategy-Simulation: echte VP-Physik | Niedrig | linearisiertes Modell ist Näherung |
| Dashboard-Tab: Demo-Daten statt echte | Mittel | mit echten Account-Daten füllen |
