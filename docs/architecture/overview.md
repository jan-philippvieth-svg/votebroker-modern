# VoteBroker – Architektur-Übersicht

**Stand:** 2026-05-31

---

## System-Übersicht

```
Browser
  └── React SPA (apps/web)
        ├── api.ts          → HTTP-Fetches (relative URLs → nginx)
        └── App.tsx         → State, Routing (Tabs), alle Komponenten

nginx (Caddy-/nginx-Proxy)
  ├── / → static HTML/JS/CSS (aus dist/)
  └── /api/* → proxy_pass → api:3000

API-Server (apps/api) – Fastify
  ├── /api/auth/...         → SteemConnect OAuth
  ├── /api/votes/...        → Quote & Execute
  ├── /api/curation/dna    → Vote-DNA Analyse
  ├── /api/community/...   → Community Pool
  ├── /api/consents/...    → Consent Management
  └── /api/operator/...    → Operator Dashboard (token-protected)

Domain-Paket (packages/domain)
  ├── curationDna.ts       → AuthorStats, CurationProfile, analyzeCurationHistory()
  ├── voteMath.ts          → Vote-Gewichts-Berechnungen
  ├── voteTiming.ts        → Timing-Score-Logik
  ├── powerStable.ts       → VP-Nachhaltigkeits-Berechnungen
  └── billing.ts           → Fee-Logik

Externe APIs
  ├── api.steemit.com      → Vote-History, Account-Daten
  └── steemlogin.com       → OAuth (SteemConnect)
```

---

## Monorepo-Struktur

```
/opt/votebroker-modern/
├── apps/
│   ├── api/src/           → Fastify API-Server
│   └── web/src/           → React SPA
│       ├── api.ts         → API-Typen + Fetch-Funktionen
│       ├── i18n.ts        → Übersetzungen (de/en)
│       └── views/
│           ├── App.tsx    → Haupt-Komponente + State
│           └── OperatorDashboard.tsx
├── packages/
│   └── domain/src/        → Shared Business Logic
│       ├── curationDna.ts
│       ├── voteMath.ts
│       └── ...
├── docs/                  → Dieses Verzeichnis
│   ├── devlog/            → Tägliche Änderungseinträge
│   ├── decisions/         → ADRs
│   ├── architecture/      → Architektur-Dokumentation
│   └── roadmap/           → Produkt-Roadmap
└── docker-compose.prod.yml
```

---

## Deployment

Docker Compose (Production):
- `votebroker_web_1` — nginx, serviert gebaute SPA-Dateien
- `votebroker_api_1` — Fastify API-Server
- `votebroker_caddy_1` — TLS-Termination + Reverse Proxy

Build-Prozess:
```bash
npm run build  # baut alle Workspaces in Reihe
# 1. @votebroker/domain → packages/domain/dist/
# 2. @votebroker/api    → apps/api/dist/
# 3. @votebroker/web    → apps/web/dist/

docker cp apps/web/dist/. votebroker_web_1:/usr/share/nginx/html/
```

---

## State-Management (Frontend)

Kein externes State-Management. Alles in `App.tsx` via `useState`/`useEffect`:

```
App
├── session: AuthSession | null      → Login-Status
├── accountSnapshot: SteemSnapshot   → Live VP, SP, Preis
├── curationProfile: CurationProfile → Vote-DNA Analyse
├── strategyRules: StrategyRule[]    → Editierbare Curation-Strategie
├── consentState: ConsentState       → Consent-Status
├── communityOverview: ...           → Community Pool
└── ... (weitere UI-States)
```

Persistenz via localStorage:
- `votebroker.session` — Auth-Session
- `votebroker.strategy` — Curation-Strategie (lokal)
- `votebroker.locale` — Sprache

---

## Vote-DNA Pipeline

```
Steem-API (Vote-History)
  ↓ fetchVoteHistory(username, maxVotes=500)
  ↓ VoteRecord[] (author, permlink, weight, timestamp)
  ↓ analyzeCurationHistory()
  │   ├── Per-Author: voteCount, avgWeightBps, lastVoteMs
  │   ├── compositeScore = voteCount × avgWeightPct × recency(30d)
  │   ├── selectionReasons[] (regelbasiert)
  │   ├── top-50 Autoren sortiert nach compositeScore
  │   ├── peakHoursUtc (Top-8 Stunden)
  │   ├── dnaLabel + dnaDescription (Klassifikation)
  │   └── powerStable (Budget, suggestedTopWeights)
  ↓ CurationProfile
  ↓ generateStrategyFromProfile()
  │   ├── Rang-basierte Kategorie-Zuweisung
  │   ├── computeDynamicWeights() mit Prioritäts-Multiplikatoren
  │   └── StrategyRule[] mit max/min Weight, source, reasons
  ↓ StrategyEditor (UI)
      └── Nutzer editiert → localStorage → (zukünftig: API)
```
