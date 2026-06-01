# ADR-001: Vote-DNA Strategy System

**Datum:** 2026-05-31
**Status:** implementiert

---

## Kontext

VoteBroker analysiert die Vote-Historie eines Nutzers (Vote-DNA). Die Analyse ergab nützliche Daten: Top-Autoren, Aktivitätszeiten, Gewichtungsmuster. Der nächste logische Schritt war, diese Daten in eine handlungsfähige Auto-Curation-Strategie zu überführen.

## Problem

Wie überführt man rohe Vote-Analyse-Daten in eine konfigurierbare, nachhaltige Curation-Strategie, die:
- transparent begründet warum Autoren ausgewählt wurden
- vom Nutzer vollständig überschreibbar ist
- Voting Power nachhaltig hält
- ohne Backend-Persistenz (MVP) funktioniert

## Optionen

**Option A:** Statische Empfehlungsliste
Pros: einfach. Cons: nicht editierbar, kein Lerneffekt, kein Workflow.

**Option B:** Vollständiger Backend-gespeicherter Strategy-Manager
Pros: persistent, server-seitig ausführbar. Cons: benötigt API-Endpoint, DB-Schema, Auth-Integration — zu früh für aktuellen Stand.

**Option C:** Clientseitiger Strategy-Editor mit localStorage-Persistenz (gewählt)
Pros: sofort nutzbar, kein Backend-Aufwand, volle Editierbarkeit, Grundlage für spätere Backend-Anbindung. Cons: Daten nur im Browser.

## Entscheidung

Option C. Clientseitiger Editor mit localStorage. Strategie wird aus Vote-DNA generiert, ist vollständig editierbar, und wird im Browser persistiert bis Backend-Persistenz implementiert wird.

## Begründung

- MVP-Ansatz: Nutzer-Workflow und UX zuerst validieren, dann Backend
- localStorage reicht für Single-User-Nutzung vollständig aus
- Datei-Schema ist bereits definiert (`StrategyRule[]`) und kann 1:1 an API gesendet werden
- Kein Breaking Change wenn Backend später hinzukommt

## Konsequenzen

- `strategyRules: StrategyRule[] | null` lebt in App-State (nicht in Unterkomponenten)
- localStorage-Key: `votebroker.strategy`
- Zukünftige Backend-Anbindung: `POST /api/strategy` mit gleichem JSON-Shape
- Community-Tab kann über `addAuthorToStrategy()` in App interagieren
- Regenerieren ohne manuelle Overrides zu verlieren: `manuallyModified: boolean` Flag pro Regel
