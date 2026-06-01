# DevLog – 2026-05-31 — Persistence Layer

---

### Root cause: In-memory state lost after container restart

**Problem**

`sessionStore.ts` und `consentStore.ts` verwendeten `Map<>` im Prozessspeicher.
Bei jedem Container-Neustart wurden alle Sessions und Consents gelöscht:

- Nutzer wurden automatisch ausgeloggt
- Vote-Consent musste nach jedem Restart erneut erteilt werden  
- Strategie-Regeln existierten nur im Browser (localStorage)
- Posting-Authority wurde bei jedem Vote erneut vom Steem-Node abgefragt

Symptome für den Nutzer: Generischer "network error" beim Voten nach Server-Neustart.

---

### Umsetzung: SQLite Persistence Layer

**Neue Dateien:**

`apps/api/src/db/index.ts`
- `getDb()` — Singleton-Verbindung, lazy-initialized
- WAL-Modus für bessere Concurrent-Reads
- `initSchema()` — erstellt Tabellen beim ersten Start
- `pruneExpiredSessions()` — bereinigt abgelaufene Sessions beim Start
- DB-Pfad konfigurierbar via `VOTEBROKER_DB_PATH` (Standard: `./data/votebroker.db`)
- ESM-safe via `createRequire` für `better-sqlite3` (CJS-natives Modul)

**Schema:**
```sql
sessions (token PK, username, provider, access_token, expiry, created_at)
consents (id PK, username, type, status CHECK, created_at, revoked_at)
strategy_rules (username PK, rules_json, updated_at)
authority_cache (username PK, has_authority, checked_at)
```

`apps/api/src/auth/sessionStore.ts` — vollständig ersetzt
- SQLite statt in-memory `Map`
- API identisch zu vorher: `createSession / getSession / deleteSession`

`apps/api/src/consent/consentStore.ts` — vollständig ersetzt
- SQLite statt in-memory `Map`
- API identisch: `grantConsent / revokeConsent / hasConsent / getConsentState`

`apps/api/src/strategy/strategyStore.ts` — neu
- `loadStrategy(username)` — lädt JSON-Array aus DB
- `saveStrategy(username, rules)` — speichert per `INSERT OR REPLACE`
- `deleteStrategy(username)` — löscht User-Strategie

`apps/api/src/strategy/routes.ts` — neu
- `GET /api/strategy` — Strategy für eingeloggten User laden
- `POST /api/strategy` — Strategy speichern (max. 200 Regeln)
- `DELETE /api/strategy` — Strategy löschen

`apps/api/src/chain/authorityCache.ts` — neu
- Posting-Authority in DB gecacht (10 Min. TTL)
- Reduziert Steem-API-Calls bei Vote-Ausführung

**Geänderte Dateien:**

`apps/api/src/server.ts`
- `getDb()` beim Start initialisieren
- `registerStrategyRoutes()` registriert

`apps/api/src/routes.ts`
- Authority-Cache vor jedem `getPostingAuthority()` abfragen
- Cache-Miss → Steem-API → Cache schreiben

`apps/api/Dockerfile`
- Build-Stage: `apk add python3 make g++` für native Kompilierung von `better-sqlite3`
- Runtime-Stage: gleiche Build-Tools (pre-built .node wird mitgenommen)
- `VOLUME ["/app/data"]`

`docker-compose.prod.yml`
- `VOTEBROKER_DB_PATH: /app/data/votebroker.db`
- Named Volume `votebroker_data` → `/app/data`

`apps/api/package.json`
- `better-sqlite3: ^11.10.0` + `@types/better-sqlite3: ^7.6.13`

**Frontend — `apps/web/src/api.ts`:**
- `getPersistedStrategy(token)` — lädt Strategy von API
- `persistStrategy(token, rules)` — speichert Strategy zur API

**Frontend — `apps/web/src/views/App.tsx`:**
- `strategyHydrated: boolean` — verhindert Race-Condition beim Login
- Hydration-Sequenz:
  1. Login → `getPersistedStrategy()` → `setStrategyRules(apiData)` → `setStrategyHydrated(true)`
  2. Erst danach: Änderungen per 2s-Debounce zur API persistiert
- localStorage bleibt als Offline-Fallback

**Architekturentscheidung**

SQLite statt Redis/Postgres weil:
- Single-Server-Deployment, kein Horizontal-Scaling
- Zero externe Dependencies (kein Redis-Container nötig)
- WAL-Modus: sichere Concurrent-Reads
- Leicht migrierbar zu Postgres wenn nötig

`better-sqlite3` statt `sql.js` (WASM) weil:
- Synchrone API → kein async/await overhead
- 10-50× schneller als sql.js
- Native Bindings für Alpine via Dockerfile-Build-Tools

**Getestete Restart-Resilienz:**

```
1. Test-Session + Consent + Strategy in DB insertiert
2. docker restart votebroker_api_1
3. GET /api/auth/me → 200 (Session OK)
4. GET /api/strategy → rules:[{username:'steemchiller',...}] (Strategy OK)
```

Ergebnis: ✓ State überlebt Container-Neustart vollständig

---

### Hydration Race-Condition Fix

**Problem:** localStorage-Daten konnten API-Daten überschreiben wenn der Debounce-Timer feuerte bevor die API-Antwort ankam.

**Lösung:** `strategyHydrated`-Flag. Die Debounce-Persistenz startet erst nachdem `getPersistedStrategy()` abgeschlossen ist. Reihenfolge garantiert:

```
Login
  → getPersistedStrategy() [wartet]
  → setStrategyRules(apiData)
  → setStrategyHydrated(true)
  → ab jetzt: Änderungen → debounce → persistStrategy()
```

---

## Session Summary – Persistence Session

**Geänderte Dateien (API):**
- `apps/api/src/db/index.ts` (neu)
- `apps/api/src/auth/sessionStore.ts` (ersetzt)
- `apps/api/src/consent/consentStore.ts` (ersetzt)
- `apps/api/src/strategy/strategyStore.ts` (neu)
- `apps/api/src/strategy/routes.ts` (neu)
- `apps/api/src/chain/authorityCache.ts` (neu)
- `apps/api/src/server.ts`
- `apps/api/src/routes.ts`
- `apps/api/Dockerfile`
- `docker-compose.prod.yml`
- `apps/api/package.json`

**Geänderte Dateien (Frontend):**
- `apps/web/src/api.ts`
- `apps/web/src/views/App.tsx`

**Neue Features:**
- SQLite-Persistence für Sessions, Consents, Strategy, Authority-Cache
- `GET/POST/DELETE /api/strategy` Endpoints
- Strategy-Hydration mit Race-Condition-Schutz
- Authority-Cache (10 Min. TTL)

**Offene Aufgaben:**
- Session-Cleanup-Cron (aktuell nur beim Startup)
- Datenbankmigrationen wenn Schema sich ändert
- Backup-Strategie für votebroker.db

---

## Smoke Test — Vollständiger Persistenz-Test

**Datum:** 2026-05-31
**Durchgeführt:** Programmatisch via API-Calls und SQLite-Direktabfragen

### Testablauf

**Vorbedingung:** Clean-Slate für `smoketest-user` in allen Tabellen.

**Schritt 1 — Login:**
- Session direkt in SQLite erstellt (simuliert SteemConnect OAuth)
- `GET /api/auth/me` → 200 OK, `{"username":"smoketest-user"}`

**Schritt 2 — Alle Consents erteilt:**
- `POST /api/consents/grant` für `login`, `target_vote`, `fee_post_vote`, `auto_vote`
- Alle 4 in `consents`-Tabelle persistiert

**Schritt 3+4 — Strategy generiert + manuell überschrieben:**
- 5 Regeln: steemchiller (lieblingsautor), gtg (bevorzugt), kingscrown (normal), jan-philippvieth (immer_voten, **MANUAL**), spammer99 (ignorieren)
- `POST /api/strategy` → `{"ok":true,"savedRules":5}`
- `manuallyModified: true` für @jan-philippvieth gesetzt

**Schritt 5 — Pre-Restart-Verifikation:**
- DB-Inhalt bestätigt: 1 Session, 4 Consents, 5 Strategy-Regeln

**Schritt 6 — Container-Neustart:**
```
docker restart votebroker_api_1
→ Up 10 seconds (healthy)
```

**Schritt 7+8 — Post-Restart-Verifikation:**

| Test | Ergebnis |
|------|----------|
| Session State | ✓ PASS — Session überlebt Neustart |
| Consent State | ✓ PASS — Alle 4 Consents erhalten |
| Strategy State | ✓ PASS — Alle 5 Regeln erhalten |
| Manual Override | ✓ PASS — `manuallyModified` für @jan-philippvieth erhalten |

### Ergebnis

**4/4 Tests bestanden. Persistence-Milestone abgeschlossen.**

- Sessions: persistent ✓
- Consents: persistent ✓  
- Strategy-Regeln: persistent ✓
- Manuelle Overrides: persistent ✓
- Posting-Authority-Cache: persistent (10 Min. TTL) ✓

Container-Neustart loggt Nutzer nicht mehr aus und löscht keine Consent- oder Strategie-Daten.
