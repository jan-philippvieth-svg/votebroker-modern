# ADR-002: Dynamische Budget-Allokation für Voting-Strategie

**Datum:** 2026-05-31
**Status:** implementiert

---

## Kontext

Auto-Curation muss Voting Power nachhaltig halten. Zu aggressives Voten entleert die VP, zu konservatives verschenkt Potenzial. Unterschiedliche Autoren verdienen unterschiedliche Priorität.

## Problem

Wie weist man Autoren automatisch Gewichte zu, die:
- die Voting Power langfristig im Zielbereich (80–95%) halten
- höher priorisierten Autoren mehr Gewicht geben
- ohne manuelle Feinabstimmung jedes einzelnen Autors funktionieren

## Optionen

**Option A:** Feste Prozentzahlen pro Kategorie (z.B. Lieblingsautor = 40%)
Cons: ignoriert tatsächliche VP und Voting-Frequenz. Bei vielen Lieblingsautoren → VP-Entleerung.

**Option B:** Proportionale Verteilung nach Häufigkeit (bisheriger Ansatz)
Cons: Häufigkeit ≠ Priorität. Ein Autor mit 30 Low-Weight-Votes bekommt mehr Budget als einer mit 5 High-Weight-Votes.

**Option C:** Priority-Multiplikatoren auf geteiltem Tages-Budget (gewählt)
```
Gesamt-Budget: 2000 BPS/Tag (= 20% VP-Regen)
Total-Einheiten = Σ (Autoren × Multiplikator)
Budget pro Autor = (Budget / Total-Einheiten) × Multiplikator
```

## Entscheidung

Option C. Multiplikatoren:
```
🔥 immer_voten:    4.0×
⭐ lieblingsautor: 2.5×
🟦 bevorzugt:      1.5×
⚪ normal:         1.0×
⬇ niedrig:        0.4×
🚫 ignorieren:     0.0
```

## Begründung

- Selbst-regulierend: mehr Autoren → weniger Gewicht pro Autor, VP bleibt stabil
- Kategorie-Änderung durch Nutzer verändert automatisch alle Gewichte
- Leicht erweiterbar (neue Kategorien, veränderte Multiplikatoren)
- Simulation-Panel zeigt sofortigen Impact

## Konsequenzen

- `computeDynamicWeights()` wird bei jeder Strategie-Generierung aufgerufen
- Nutzer können Max/Min% manuell überschreiben (dann `manuallyModified: true`)
- Simulation-Panel rechnet mit `maxWeightPct`-Werten (nicht mit dynamisch berechneten)
- Zukünftig: Account-spezifische Kalibrierung (SP, aktuelle VP, historische Regeneration)

## Beispielrechnung

10 aktive Autoren: 2× Lieblingsautor (2.5), 3× Bevorzugt (1.5), 5× Normal (1.0)
```
Total-Einheiten = 2×2.5 + 3×1.5 + 5×1.0 = 5 + 4.5 + 5 = 14.5
Budget pro Einheit = 2000 / 14.5 = 137.9 BPS
Lieblingsautor: 137.9 × 2.5 = 344.8 BPS ≈ 3.45%
Bevorzugt:      137.9 × 1.5 = 206.9 BPS ≈ 2.07%
Normal:         137.9 × 1.0 = 137.9 BPS ≈ 1.38%
```
