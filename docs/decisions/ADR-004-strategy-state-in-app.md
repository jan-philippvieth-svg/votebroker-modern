# ADR-004: Strategy-State in App-Komponente (State Lift)

**Datum:** 2026-05-31
**Status:** implementiert

---

## Kontext

Der erste Entwurf des Strategy-Editors hatte `strategyRules` als lokalen State in `CurationDnaPanel`. Dies funktionierte für den DNA-Tab allein.

## Problem

Mehrere Teile der App sollen mit der Strategie interagieren:
- Community-Tab: "Autor zur Strategie hinzufügen"
- Dashboard: Strategie-Status anzeigen
- Zukünftig: Billing-Tab (welche Autoren werden bevorzugt gevoted)

Mit lokalem State in `CurationDnaPanel` ist das nicht möglich ohne Prop-Drilling oder Context.

## Optionen

**Option A:** Lokaler State in CurationDnaPanel (verworfen)
Cons: andere Tabs können nicht interagieren.

**Option B:** React Context / Zustand / Redux
Pros: sauber für große Apps. Cons: Over-Engineering für aktuellen Stand.

**Option C:** State in App heben (gewählt)
Pros: einfach, direkt, kein externes State-Management. Cons: bei sehr großer App wird App.tsx schwer.

## Entscheidung

Option C. `strategyRules: StrategyRule[] | null` und `setStrategyRules` in App. `addAuthorToStrategy()` als Funktion in App, wird als Prop weitergegeben.

## Begründung

Die App ist aktuell Single-Page mit einer App-Komponente. Context würde die gleiche Boilerplate erfordern ohne Mehrwert. Bei wachsender Komplexität kann in einen Context oder Zustand migriert werden.

## Konsequenzen

- `CurationDnaPanel` erhält `strategyRules` und `onStrategyChange` als Props
- `CommunityPoolSection` erhält `onAddToStrategy` als optionalen Prop
- `addAuthorToStrategy()` in App berechnet Initialgewichte basierend auf aktuellem `curationProfile`
- localStorage-Sync via `useEffect([strategyRules])` in App

## Migrations-Pfad zu Backend

Wenn Backend-Persistenz kommt:
1. `POST /api/strategy` mit `{ rules: StrategyRule[] }` beim Speichern
2. `GET /api/strategy` beim Login statt localStorage
3. localStorage als Offline-Fallback behalten
