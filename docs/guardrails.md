# VoteBroker Quality Guardrails

Dieser Überblick dokumentiert alle aktiven Safety- und Quality-Guards im System.
Ziel: Neue Entwickler verstehen sofort welche Schutzmechanismen existieren, warum sie eingebaut wurden, und wo sie zu finden sind.

---

## 1. Draft Review Guardrail

**Zweck:** Verhindert Veröffentlichung von Devlog-Posts die noch Placeholder-Text enthalten.

**Problem das gelöst wurde:**  
Der Devlog-Generator schreibt `*Keine Commit-Daten — bitte manuell ergänzen...*` wenn er keinen Git-Zugriff hat (der API-Container sieht kein `.git`-Verzeichnis). Ohne Guard könnte dieser Text direkt auf die Steem-Blockchain publiziert werden.

**Eingeführt:** Commit `d54184b`

**Betroffene Dateien:**
- `apps/web/src/views/AdminDashboard.tsx` — Frontend-Guard (UI)
- `apps/api/src/admin/contentRoutes.ts` — Backend-Guard (API)

**Wie es funktioniert:**

```typescript
// Frontend (AdminDashboard.tsx)
const PLACEHOLDER_MARKER = "Keine Commit-Daten";
const hasPlaceholder = !!(preview?.content && preview.content.includes(PLACEHOLDER_MARKER));

// Review-Button gesperrt solange Placeholder vorhanden
<button disabled={saving || hasPlaceholder}>Review ✓</button>

// Orange Warnung erscheint im Preview
{hasPlaceholder && <div>Draft enthält ungefüllte Commit-Daten...</div>}
```

```typescript
// Backend (contentRoutes.ts) — zweite Schutzschicht beim Publish-Call
const PLACEHOLDER_PATTERNS = [
  { pattern: /bitte manuell ausfüllen/i, label: '"bitte manuell ausfüllen"' },
  { pattern: /\bTODO\b/, label: 'TODO' },
  { pattern: /\bPLACEHOLDER\b/i, label: 'PLACEHOLDER' },
  // ... weitere Muster
];
// → HTTP 403 wenn Draft Placeholder enthält
```

**Schichtenmodell:**
- Layer 1: Frontend zeigt Warnung + sperrt Review-Button
- Layer 2: API lehnt Publish-Request ab (`violations` im Response)

---

## 2. Translation Key Guardrail

**Zweck:** Verhindert stille Mixed-Language-Fehler wenn Translation-Keys fehlen oder neue Features ohne i18n integriert werden.

**Problem das gelöst wurde:**  
Bei wachsendem Feature-Scope wurden neue Texte teils hardcoded hinzugefügt (DE oder EN), andere über `t()`. Das erzeugte Mixed-Content wenn Nutzer die Sprache wechselten — ohne sichtbaren Fehler.

**Eingeführt:** Commit `cd694bc`

**Betroffene Dateien:**
- `apps/web/src/i18n.ts` — Translations + Guard-Logik

**Wie es funktioniert — zwei Mechanismen:**

### A) TypeScript `satisfies` — Compile-Time Guard

```typescript
const translations = {
  de: { key1: "...", key2: "..." },
  en: { key1: "...", key2: "..." },
} satisfies Record<Locale, Record<string, string>>;
```

`satisfies` erzwingt zur Build-Zeit dass DE und EN **exakt dieselben Keys** haben.
Fehlt ein Key in einer Sprache → TypeScript-Fehler, Build schlägt fehl.

### B) `⚠ key`-Fallback — Runtime Guard

```typescript
export function createTranslator(locale: Locale) {
  const dict = translations[locale] as Record<string, string>;
  const en   = translations.en as Record<string, string>;
  return (key: TranslationKey): string => {
    const val = dict[key] ?? en[key];
    if (val !== undefined) return val;
    if (import.meta.env.DEV) return `⚠ ${key}`;  // DEV: sofort sichtbar
    return key;                                     // PROD: Key-Name als Fallback
  };
}
```

In Development erscheint `⚠ fehlender.key` direkt im UI — kein stilles Fallback auf Englisch oder Leerstring.

**Schichtenmodell:**
- Layer 1: TypeScript `satisfies` — Compile-Time, verhindert asymmetrische Key-Sets
- Layer 2: `⚠`-Fallback — Runtime, macht fehlende Keys in DEV sofort sichtbar

---

## 3. API Publish Validation

**Zweck:** Letzte Schutzschicht vor dem Blockchain-Broadcast — validiert Draft-Inhalt serverseitig.

**Eingeführt:** Im Rahmen der Content-Routes (`apps/api/src/admin/contentRoutes.ts`)

**Was geprüft wird:**
```typescript
const PLACEHOLDER_PATTERNS = [
  /bitte manuell ausfüllen/i,
  /\bTODO\b/,
  /\bTBD\b/,
  /\bPLACEHOLDER\b/i,
  /interner Hinweis/i,
  /vor der Veröffentlichung.*entfernen/i,
  /<!--.*?(EDIT|TODO|REVIEW).*?-->/is,
  // ...
];
```

**Response bei Violation:**
```json
{ "error": "content_validation_failed", "violations": ["TODO", "PLACEHOLDER"] }
```

Frontend zeigt: `🚫 Blocked: TODO, PLACEHOLDER`

---

## 4. Secret Guard (Screenshot Pipeline)

**Zweck:** Verhindert dass Session-Tokens, API-Keys oder andere Secrets in Screenshots erscheinen die auf Steem publiziert werden.

**Eingeführt:** Commit `6316408`

**Betroffene Dateien:**
- `tools/showcase/capture_story.py` — DOM-Scan vor jedem Screenshot

**Wie es funktioniert:**
```python
SECRET_PATTERNS = [r'session=', r'token=', r'Bearer ', r'private_key', ...]
# Scannt DOM-Text vor dem Screenshot
# Bricht ab wenn Muster gefunden → kein Screenshot mit Secrets
```

---

## Übersicht

| Guard | Schicht | Commit | Wann greift er |
|---|---|---|---|
| Draft Review Guardrail | Frontend (UI) | `d54184b` | Vor Review-Klick |
| API Publish Validation | Backend (API) | Content-Routes | Vor Blockchain-Broadcast |
| Translation Key Guard (TS) | Compile-Time | `cd694bc` | Bei `npm run build` |
| Translation Key Guard (RT) | Runtime (DEV) | `cd694bc` | Im Browser (DEV-Modus) |
| Secret Guard | Capture-Script | `6316408` | Vor jedem Screenshot |

---

## Prinzip

Alle Guards folgen demselben Grundprinzip:
**Fehler sichtbar machen, bevor sie irreversibel werden.**

- Draft-Fehler sind nach Blockchain-Publish nicht mehr korrigierbar
- Mixed-Language-Bugs sind ohne sichtbaren Fehler schwer zu finden  
- Secrets in Screenshots sind nach Veröffentlichung kompromittiert

Jeder neue Guard sollte dieselbe Frage beantworten:
> *Was passiert, wenn dieser Fehler unbemerkt durch das System geht?*
