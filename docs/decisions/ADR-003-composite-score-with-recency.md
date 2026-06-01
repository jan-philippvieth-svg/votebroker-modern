# ADR-003: Composite Score mit Recency-Gewichtung für Author-Ranking

**Datum:** 2026-05-31
**Status:** implementiert

---

## Kontext

Das Author-Ranking für Vote-DNA bestimmte bisher welche Autoren in `topAuthors` erscheinen und welche Kategorie sie erhalten. Die bisherige Sortierung nach `voteCount` (Häufigkeit) benachteiligte strategisch wichtige Autoren.

## Problem

Beispiel-Fall:
- Autor A: 30 Votes × 1% Gewicht = wenig Conviction, aber häufig
- Autor B: 5 Votes × 80% Gewicht = sehr hohe Conviction, selten

Bisheriger Ansatz: Autor A erhält höhere Priorität.
Gewünschtes Verhalten: Autor B sollte höher gerankt werden.

Zusätzlich: Votes die 3 Monate alt sind sollten weniger zählen als Votes von letzter Woche.

## Optionen

**Option A:** Nur vote count (bisheriger Ansatz)
Cons: ignoriert Gewicht und Aktualität.

**Option B:** `voteCount × avgWeightPct` (einfacher Composite)
Pros: berücksichtigt Conviction. Cons: ignoriert Recency.

**Option C:** `voteCount × avgWeightPct × recencyFactor` (gewählt)
```typescript
recencyFactor = Math.max(0.1, Math.exp(-lastVoteDaysAgo / 30))
compositeScore = voteCount × avgWeightPct × recencyFactor
```

## Entscheidung

Option C. Exponentieller Recency-Decay mit Halbwertszeit 30 Tage.

## Begründung

- Exponentieller Decay ist das natürliche Modell für "Relevanz nimmt ab"
- Halbwertszeit 30 Tage: Votes von vor einem Monat zählen noch 50%, vor 3 Monaten ~5%
- Unterer Clamp bei 0.1: Sehr alte Votes (> 90 Tage) werden nicht komplett ignoriert
- Liefert intuitiv nachvollziehbare Ergebnisse ohne Parameter-Tuning

## Konsequenzen

- `authorLastMs` wird pro Autor getrackt (neuester Vote-Timestamp)
- Sortierung von topAuthors nach compositeScore statt voteCount
- Top-50 statt Top-15 (mehr Autoren im Pool um strategisch wichtige nicht zu verlieren)
- `lastVoteDaysAgo` wird an Frontend übergeben und in expandiertem Row angezeigt
- `selectionReasons` erklärt den Score in menschlich lesbarer Form

## Messbare Verbesserung

Vor dieser Änderung: Autoren mit 1-2 hochgewichteten Votes tauchten nicht in Top-15 auf.
Nach dieser Änderung: Top-50 sortiert nach Conviction × Recency, strategische Autoren erscheinen.

## Zukünftige Erweiterungen

- Consistency-Score: Gleichmäßige Verteilung über Analyse-Periode (nicht nur letzter Wert)
- Tag-Weighting: Votes auf bestimmte Tags / Communities höher gewichten
- Engagement-Score: Curation-Reward basierte Gewichtung
