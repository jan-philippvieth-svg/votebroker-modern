# Vote-DNA Datenmodell

**Stand:** 2026-05-31

---

## AuthorStats

Repräsentiert einen Autor in der Vote-DNA-Analyse. Sortiert nach `compositeScore`.

```typescript
interface AuthorStats {
  username: string;

  // Häufigkeit
  voteCount: number;       // Anzahl Upvotes für diesen Autor
  sharePct: number;        // Anteil an allen Upvotes (%)

  // Conviction
  avgWeightPct: number;    // Durchschnittliches Vote-Gewicht (%)
                           // = Σ(weight) / voteCount / 100

  // Composite Ranking
  compositeScore: number;  // voteCount × avgWeightPct × recencyFactor
                           // recencyFactor = exp(-lastVoteDaysAgo / 30)
                           // Halbwertszeit: 30 Tage

  // Recency
  lastVoteDaysAgo: number; // Tage seit letztem Vote (0 = heute)

  // Transparenz
  selectionReasons: string[]; // Erklärende Tags (de)
}
```

### Composite Score Formel

```
compositeScore = voteCount × avgWeightPct × max(0.1, exp(-lastVoteDaysAgo / 30))
```

Beispiele:
```
30 Votes × 1% × recency(0d)  = 30 × 1 × 1.0   = 30.0  → niedrig
5 Votes  × 80% × recency(0d) = 5 × 80 × 1.0   = 400.0 → sehr hoch
5 Votes  × 80% × recency(30d)= 5 × 80 × 0.5   = 200.0 → noch hoch
5 Votes  × 80% × recency(90d)= 5 × 80 × 0.05  = 20.0  → niedrig
```

---

## StrategyRule

Eine Curation-Strategie-Regel für einen Autor.

```typescript
type StrategyCategory =
  | "immer_voten"    // 🔥 Jeder neue Post wird gevoted
  | "lieblingsautor" // ⭐ Hohe Priorität, viel Budget
  | "bevorzugt"      // 🟦 Normale+ Priorität
  | "normal"         // ⚪ Standard-Priorität
  | "niedrig"        // ⬇ Wenig Budget
  | "ignorieren";    // 🚫 Nicht voten

interface StrategyRule {
  username: string;
  category: StrategyCategory;

  // Gewicht
  maxWeightPct: number;       // Maximales Vote-Gewicht (%), dynamisch berechnet
  minWeightPct: number;       // Mindest-Gewicht (%, 0 bei den meisten Kategorien)

  // Ausführung
  enabled: boolean;           // Aktiv/Inaktiv

  // Herkunft
  source: string;             // "Vote-DNA" | "Manuell" | "Community"
  manuallyModified: boolean;  // true wenn Nutzer manuell geändert hat

  // Vote-DNA Daten (0 wenn manuell hinzugefügt)
  sharePct: number;
  voteCount: number;
  avgWeightPct: number;
  lastVoteDaysAgo: number;
  selectionReasons: string[];
}
```

---

## Prioritäts-Multiplikatoren

| Kategorie | Multiplikator | Bedeutung |
|-----------|--------------|-----------|
| 🔥 immer_voten | 4.0× | Immer, Maximalgewicht |
| ⭐ lieblingsautor | 2.5× | Sehr hoch |
| 🟦 bevorzugt | 1.5× | Hoch |
| ⚪ normal | 1.0× | Standard |
| ⬇ niedrig | 0.4× | Minimal |
| 🚫 ignorieren | 0.0 | Kein Vote |

### Beispiel Budget-Rechnung

Budget: 2000 BPS/Tag, 12 Votes/Tag, 2 Lieblingsautoren, 5 Bevorzugt, 5 Normal

```
Total-Einheiten = 2×2.5 + 5×1.5 + 5×1.0 = 5 + 7.5 + 5 = 17.5
BPS/Einheit = 2000 / 17.5 = 114.3

Lieblingsautor: 114.3 × 2.5 = 285.7 BPS ≈ 2.86%
Bevorzugt:      114.3 × 1.5 = 171.4 BPS ≈ 1.71%
Normal:         114.3 × 1.0 = 114.3 BPS ≈ 1.14%

Tages-Verbrauch: 2×286 + 5×171 + 5×114 = 572 + 855 + 570 = 1997 BPS ≈ 20%
→ Nachhaltig (= Regen-Rate)
```

---

## Selektions-Gründe (selectionReasons)

| Bedingung | Tag |
|-----------|-----|
| voteCount ≥ 10 | "Sehr hohe Aktivität" |
| voteCount ≥ 5 | "Regelmäßige Aktivität" |
| avgWeightPct ≥ 80 | "Konstant hohe Vote-Gewichte" |
| avgWeightPct ≥ 50 | "Überdurchschnittliches Gewicht" |
| avgWeightPct ≥ 30 | "Mittleres Conviction-Level" |
| sharePct ≥ 10 | "Sehr hoher Anteil aller Votes" |
| sharePct ≥ 5 | "Hoher Anteil aller Votes" |
| lastVoteDaysAgo ≤ 2 | "Kürzlich gevoted" |
| lastVoteDaysAgo ≤ 7 | "Aktuelle Voting-Beziehung" |
| voteCount ≥ periodDays/7 AND periodDays ≥ 21 | "Langfristige Voting-Beziehung" |
| avgWeightPct ≥ 70 AND voteCount ≥ 3 | "Strategisch wichtiger Autor" |
| sharePct ≥ 5 AND totalAuthors > 20 | "Top-Autor in deiner Community" |

---

## localStorage Schema

Key: `votebroker.strategy`
Value: `JSON.stringify(StrategyRule[])`

Wird bei jeder Änderung via `useEffect([strategyRules])` aktualisiert.
Wird beim App-Start via `useState(() => JSON.parse(localStorage.getItem(...)))` geladen.
