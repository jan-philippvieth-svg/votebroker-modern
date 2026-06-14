# ADR-005: Opportunity Score — Korrelationsanalyse aus vb_global_vote_outcomes

**Datum:** 2026-06-14  
**Status:** Aktiv — Grundlage für Opportunity Score v2  
**Datenbasis:** 413 realisierte Votes (2026-05-31 bis 2026-06-14), n=250 mit vollständigem Kontext

---

## Kontext

Vor dem Bau der Opportunities View muss der Composite Score historisch validiert sein.
Diese Analyse prüft, welche Faktoren tatsächlich mit SP/VP korrelieren — und welche nur scheinbar.

**Zielgröße:** `sp_per_vp = realized_curation_sp / (weight_bps / 10000)`
Normiert auf VP-Einsatz, sodass Votes unterschiedlicher Gewichte vergleichbar werden.

---

## Befunde

### 1. Timing (Delay) — moderater Effekt

| Delay | avg SP/VP | median SP/VP | n |
|-------|-----------|--------------|---|
| 0–15 min | 0.108 | 0.073 | 17 |
| 15–30 min | 0.123 | 0.075 | 26 |
| 30–60 min | 0.092 | 0.076 | 27 |
| 1–2 h | 0.132 | 0.079 | 27 |
| 2–6 h | 0.090 | 0.080 | 67 |
| 6–24 h | 0.074 | 0.060 | 65 |
| 1–3 d | 0.060 | 0.060 | 64 |
| 3–7 d | 0.057 | 0.060 | 120 |

**Pearson r(log_delay, sp_per_vp) = −0.37** — moderater Effekt.

**Wichtig:** Averages werden durch Ausreißer verzerrt. Medians zeigen:
- 0–6h: Median ~0.075–0.080
- Ab 1 Tag: Median auf 0.060 abgefallen
- Threshold: Votes nach >1 Tag verlieren messbar Effizienz

### 2. Post-Payout-Sweetspot — stärkstes Signal

| Final Payout | avg SP/VP | n |
|--------------|-----------|---|
| < 0.5 SBD | 0.068 | 46 |
| 0.5–2 SBD | 0.093 | 72 |
| **2–5 SBD** | **0.099** | 31 |
| 5–10 SBD | 0.092 | 39 |
| > 10 SBD | 0.071 | 209 |

**Sweetspot: 2–10 SBD.** Sowohl sehr niedrige als auch sehr hohe Payouts sind weniger effizient.

Erklärung:
- **< 0.5 SBD**: Post-Payout-Pool zu klein — minimale absolute Curation-Rewards
- **> 10 SBD**: Viele Konkurrenten voten diese Posts → Pool-Dilution → niedrigerer relativer Anteil
- **2–10 SBD**: Ausreichend Pool-Volumen, aber noch nicht überfüllt

**Pearson r(final_payout, sp_per_vp) = −0.21** — linear schlecht, aber der nicht-lineare Effekt ist stark.

### 3. Interaktionseffekt: Timing × Payout

| Payout-Tier | < 30 min | 30 min–2 h | 2–24 h | 1+ Tag |
|-------------|----------|------------|--------|--------|
| **< 2 SBD** | 0.084 | 0.077 | 0.080 | 0.050 |
| **2–10 SBD** | **0.163** | **0.167** | 0.067 | 0.060 |
| **> 10 SBD** | 0.073 | 0.070 | 0.070 | 0.060 |

**Kernbefund:** Frühes Timing ist nur für Mid-Payout-Posts (2–10 SBD) entscheidend.
- Mid-Payout + früh: **0.16–0.17 sp/vp** — 2–3× über Durchschnitt
- High-Payout + früh: **0.07 sp/vp** — kein Vorteil gegenüber spätem Vote
- Low-Payout + früh: **0.08 sp/vp** — marginaler Vorteil

**Implikation:** Der Opportunity Score muss Timing und Payout gemeinsam bewerten — nicht unabhängig.

### 4. VP-Level beim Vote — kein Effekt

| VP-Level | avg SP/VP | n |
|----------|-----------|---|
| < 70% | 0.078 | 21 |
| 70–80% | 0.079 | 211 |
| 80–90% | 0.084 | 18 |

**Pearson r(vp_bps, sp_per_vp) = 0.05** — vernachlässigbar. VP-Höhe beim Vote beeinflusst die *relative* Curation-Effizienz nicht.

### 5. Ausreißer-Analyse

**Beste Votes** (hohe sp/vp):
- `@aatwar` (90 min, 23.66 SBD) → sp/vp = 0.73
- `@blessedlife` (22 min, 14 SBD) → sp/vp = 0.51
- `@abi24` (27 min, 11.58 SBD) → sp/vp = 0.43

Muster: Moderate–hohe Payout-Posts (10–25 SBD) mit frühem Timing (<2h). Dies widerspricht scheinbar dem Sweetspot, erklärt sich aber durch individuellen Wettbewerb: Wenn wenige andere früh voten, ist auch ein high-payout Post effizient.

**Schlechteste Votes** (niedrige sp/vp):
- `@mein-senf-dazu` (mehrere Posts, Payout < 0.1 SBD) → sp/vp ≈ 0.02
- Sehr späte Votes (9.000+ Minuten, 6+ Tage nach Veröffentlichung)
- `@trafalgar` (9.995 min, 129 SBD) → sp/vp = 0.0067 (extremer Payout = extreme Konkurrenz)

---

## Growth Factor — stärkste Korrelation (Claus-Input, 2026-06-14)

### 0. Kernerkenntnis: Growth Factor = post_final_payout / post_pending_payout

**r(log_gf, sp_per_vp) = 0.868** — mit Abstand stärkste Korrelation in der Analyse.
Vergleich: delay r=−0.37, pending r=−0.27, whale_count r=−0.32.

Growth Factor misst: "Wie stark ist der Post nach dem Vote gewachsen?"
Ein Post mit 2 SBD pending → 20 SBD final (GF=10×) ist fundamental anders als
2 SBD pending → 3 SBD final (GF=1.5×) — obwohl beide zum Vote-Zeitpunkt gleich aussehen.

n=220 Votes mit berechenbarem GF (beide Spalten gefüllt, pending > 0.01 SBD).

### Befunde Growth Factor

**GF-Buckets vs. SP/VP:**

| GF-Bucket | n | avg SP/VP | avg Pending | avg Final |
|-----------|---|-----------|-------------|-----------|
| >20× | 6 | **0.281** | 0.06 SBD | 5.11 SBD |
| 10–20× | 7 | **0.160** | 0.20 SBD | 2.68 SBD |
| 5–10× | 2 | 0.111 | 0.80 SBD | 4.23 SBD |
| 3–5× | 3 | 0.090 | 1.28 SBD | 4.80 SBD |
| 2–3× | 11 | 0.097 | 3.21 SBD | 8.37 SBD |
| 1.5–2× | 14 | 0.070 | 31.04 SBD | 55.83 SBD |
| 1–1.5× | 46 | 0.071 | 61.64 SBD | 64.37 SBD |
| <1× (gefallen) | 131 | **0.060** | 73.94 SBD | 68.32 SBD |

**Mechanismus:** Hoher GF = Pool wächst nach dem Vote → frühe Voter bekommen überproportionalen Anteil.
Niedriger GF / schrumpfend = Post war bereits auf Peak, Payout-Pool schon voll konkurriert.

### Pending Payout als Live-Prädiktor für Growth Factor

Growth Factor ist eine Post-Hoc-Metrik (erst nach Auszahlung bekannt).
Die beste live-verfügbare Annäherung zum Vote-Zeitpunkt ist Pending Payout:

| Pending bei Vote | avg GF | avg SP/VP |
|-----------------|--------|-----------|
| < 0.5 SBD | **12.76×** | 0.1163 |
| 0.5–2 SBD | 1.99× | 0.0853 |
| 2–5 SBD | 1.77× | 0.0692 |
| 5–10 SBD | 1.26× | 0.0674 |
| 10+ SBD | **0.99×** | 0.0633 |

**Konklusion:** Pending Payout (unser aktueller Score-Bestandteil "Payout Sweetspot") ist der optimale
Live-Prädiktor für Growth Factor. Die Logik stimmt überein:
Niedrig pending → Post noch nicht entdeckt → hohe Wachstumswahrscheinlichkeit.

### Author-level Growth Factor (Stufe-2-Vorstufe)

Erste Author-Level-Muster (≥3 Datenpunkte):

| Autor | n | avg GF | min GF | max GF | avg Pending | avg SP/VP |
|-------|---|--------|--------|--------|-------------|-----------|
| @solperez | 4 | **10.27×** | 2.01 | 18.14 | 0.61 SBD | 0.1549 |
| @realrobinhood | 3 | 2.82× | 1.94 | 3.79 | 4.80 SBD | 0.1074 |
| @maxinpower | 3 | 2.02× | 1.78 | 2.17 | 0.62 SBD | 0.0833 |

**Erkenntnis:** @solperez schreibt konsistent "Sleeper-Posts" (avg 0.61 SBD pending → avg 6.3 SBD final).
Das wird die Basis für den Author-History-Score: nicht nur avg sp/vp, sondern auch avg_growth_factor.

### vote_growth_snapshots — bereits vollständige Zeitreihen

| Snapshot | Rows | avg Pending | Zeitraum |
|----------|------|-------------|---------|
| vote_time | 173 | 36.88 SBD | 2026-06-11 bis heute |
| t15m | 190 | 35.86 SBD | |
| t1h | 188 | 36.90 SBD | |
| t6h | 174 | 39.59 SBD | |
| t24h | 187 | 40.27 SBD | |
| t72h | 272 | 38.43 SBD | |
| final | 397 | 43.38 SBD | |

Die Zeitreihen ermöglichen zukünftig: GF als `t72h / vote_time` (stabiler als final/pending),
oder frühe Wachstumssignale (`t1h / vote_time > 2×` = Post zieht gerade an).

### Paradigmenwechsel: Score → Expected SP/VP (Claus-Vision)

Das Ziel des CoPilots sollte nicht sein: "Dieser Post hat 92 Punkte."
Sondern: "Dieser Post hat erwartete **0.14 SP pro eingesetztem VP**."

Dann wird VP-Allokation zu einem echten Optimierungsproblem:
Maximiere Gesamt-SP aus verfügbarem VP-Budget.
Ergebnis automatisch: Post A → 35%, Post B → 25%, Post C → 20%.

**Trainingsziel (langfristig):** Lerne f(pending, delay, whale_count, author_history) → expected_sp_per_vp.
Growth Factor ist dabei die wichtigste Zielgröße im Training — weil er misst was wirklich zählt:
"Wie viel ist der Pool nach dem Vote gewachsen?"

**Nächster Schritt:** `avg_growth_factor` pro Autor in `vb_signal_author` berechnen und speichern.
Dann: Author History Score = f(avg_sp_per_vp, avg_growth_factor, cv) statt nur avg_sp_per_vp.

---

## Erweiterte Befunde (Michelangelo3-Faktoren, 2026-06-14)

### 6. Signal-Kuratoren (whale_count) — überraschend negativ

| whale_count | avg SP/VP | n |
|-------------|-----------|---|
| 1–2 | 0.093 | 36 |
| 3–5 | 0.091 | 24 |
| **6+** | **0.066** | 255 |

**Pearson r(whale_count, sp_per_vp) = −0.32** — negativ!

Gegenhypothese bestätigt: Autoren mit vielen Whale-Votern haben MORE Konkurrenz im Curation-Pool. Viele Whales = viele andere Kuratoren = kleinerer Anteil pro Vote.

**Sweetspot:** 1–5 Signal-Kuratoren. Danüber leidet der Return.

### 7. Pending Payout bei Vote-Zeitpunkt — starkes Signal, überraschende Richtung

| Pending Payout (vote time) | avg SP/VP | median | n |
|---------------------------|-----------|--------|---|
| **< 0.5 SBD** | **0.143** | **0.110** | 42 |
| 0.5–2 SBD | 0.090 | 0.080 | 16 |
| 2–5 SBD | 0.069 | 0.053 | 7 |
| 5–10 SBD | 0.069 | 0.067 | 22 |
| 10–20 SBD | 0.049 | 0.053 | 3 |
| > 20 SBD | 0.064 | 0.060 | 160 |

**Pearson r(pending_payout, sp_per_vp) = −0.27**

**Fundamentale Erkenntnis:** Niedriger Pending Payout zum Vote-Zeitpunkt = beste Rendite!

Erklärung: Post mit < 0.5 SBD pending = man ist unter den Ersten. Kaum Konkurrenz im Curation-Pool. Wenn der Post dann auf 2–10 SBD wächst, hat man einen überproportionalen Pool-Anteil.

**Auflösung des scheinbaren Widerspruchs mit Befund #2 (Sweetspot 2-5 SBD final):**
- Posts mit < 0.5 SBD pending bei Vote wachsen oft auf 2–10 SBD final
- Wir sahen dort die *Auswirkung* frühen Votens, nicht die *Ursache*
- Die eigentliche Prädiktorkette: früh voten (low pending) → guter Pool-Anteil → moderater Final-Payout

**Praktische Konsequenz:** Pending Payout < 2 SBD bei Vote-Zeitpunkt ist ein positives Signal.

**Vorhersagekraft:** `r(pending_payout, final_payout) = 0.977` — Pending Payout ist exzellenter Prädiktor für Final Payout (auf Log-Skala). Hoch-pending Posts bleiben hoch.

### 8. Autor-Konsistenz — stärkstes Author-Level-Signal

Autoren mit ≥ 3 realisierten Votes (Konsistenz-Rangliste):

| Autor | n | avg SP/VP | CV (Stabilität) |
|-------|---|-----------|----------------|
| @ruthjoe | 5 | 0.199 | 0.35 (stabil) |
| @abi24 | 7 | 0.150 | 0.84 |
| @aventurier | 8 | 0.141 | 0.72 |
| @blessedlife | 8 | 0.140 | 1.05 |
| @solperez | 6 | 0.140 | 0.38 (stabil) |
| @realrobinhood | 9 | 0.099 | 0.29 (sehr stabil) |
| @welako-history | 24 | 0.107 | 0.48 |

Unterperformer:
| @rme | 13 | 0.046 | 0.16 (stabil niedrig) |
| @mein-senf-dazu | 3 | 0.020 | 0.00 (konstant schlecht) |

**Erkenntnis:** Autor-level SP/VP ist hochprädikativer Faktor. Einige Autoren liefern konsistent 3–4× besser als andere. Dies ist die Basis für Stufe-2 (Author Ranking).

### 9. Tageszeit (UTC) — deutlicher Effekt

| Zeit UTC | avg SP/VP | n |
|----------|-----------|---|
| 16:00–20:00 | **0.113–0.129** | 8–51 |
| 12:00–14:00 | 0.093–0.125 | 11–25 |
| 23:00 | **0.146** | 7 |
| 0:00–1:00 | 0.061–0.068 | 164–247 |

**Muster:** Europäische Nachmittag-/Abendstunden (UTC 12–23 = CET 13–24) deutlich besser als Nacht/früh morgens.

**Anomalie:** n=164 Votes um UTC 0:00 mit niedrigem avg = 0.068. Vermutlich Mass-Scheduling-Artefakt des Auto-Voters in dieser Zeit.

**Wochentag:** Mittwoch (0.122), Samstag (0.099) besser als Montag (0.060) — aber Stichproben zu klein für sichere Aussage.

---

## Implikationen für den Opportunity Score

### Validierte Faktoren (nach Stärke)

| Faktor | Pearson r | Effekt | Score-Komponente |
|--------|-----------|--------|-----------------|
| Autor-Konsistenz (historisch) | — | ★★★★ sehr stark | **Author Score** (neu) |
| Pending Payout < 2 SBD | −0.27 | ★★★ stark | **Early-Mover Score** |
| Timing < 2h | −0.37 log | ★★★ moderat | Timing Score (vorhanden) |
| Tageszeit (16–23 UTC) | — | ★★★ moderat | Time-of-Day Score (neu) |
| Whale_count 1–5 | −0.32 | ★★ invers | Signal Score (Sweetspot!) |
| Votes nach 1+ Tag | — | ★★ Penaltyzone | Timing Score (vorhanden) |

### Nicht valide / schwache Faktoren

| Faktor | Pearson r | Entscheidung |
|--------|-----------|-------------|
| VP-Level beim Vote | 0.05 | Aus Score herausnehmen |
| Whale_count hoch (6+) | −0.32 | Invers — Penalty, kein Bonus |
| Finaler Payout linear | −0.21 | Pending Payout als Proxy besser |
| Wochentag | — | Stichprobe zu klein, noch nicht einbauen |

### Revised Score-Architektur (v1)

Michelangelo3-Gewichtung angepasst auf empirische Befunde:

```
Growth Score    (35%) = Author-Konsistenz-Score aus vb_global_vote_outcomes
                        ↳ historische avg sp_per_vp des Autors, normiert
Signal Score    (25%) = Whale-Sweetspot (1–5 Kuratoren optimal)
                        + Early-Mover (pending_payout < 2 SBD → Bonus)
Timing Score    (25%) = Delay < 2h + Tageszeit 12–23 UTC
Discovery Score (15%) = Autor nicht in Strategie + niedrige Konkurrenz
```

**Wichtigste Erkenntnis:** Author Score und Early-Mover (Pending Payout) sind die stärksten Faktoren — beide noch nicht im aktuellen `calcOpportunityScore` implementiert.

### Roadmap für Score-Implementierung

1. `vb_signal_author` um `avg_sp_per_vp` und `sp_per_vp_consistency` (CV) erweitern → Author Score
2. Pending Payout zur PostOpportunity hinzufügen → Early-Mover Score
3. Time-of-Day Komponente in `calcOpportunityScore` einbauen
4. Whale-Sweetspot (1–5 optimal, >6 Penalty) in whaleSignal-Score einbauen
5. Historische Re-Validierung nach 500+ weiteren realisierten Votes

---

## Datenbasis-Limitierungen

- n=413 realisierte Votes, 14 Tage Zeitfenster (2026-05-31 bis 2026-06-14)
- n=250 mit vollständigem Kontext (VP + pending payout + vote count)
- Author-level Stats: die meisten Autoren haben < 5 Datenpunkte → CV instabil
- Community-Analyse: nur 60 enriched Rows → kein verlässliches Community-Signal

**Re-Validierung:** Empfohlen nach 200–500 weiteren realisierten Votes (~4–8 Wochen, ca. Ende Juli/August 2026).

---

## VP-Weight-Optimizer (Michelangelo3-Vision)

Das eigentliche Ziel: nicht nur "welcher Post?", sondern "wie viel VP?"

Sobald Author Scores stabil sind:
```
Expected Return = vote_value × expected_growth_multiplier
expected_growth_multiplier = f(Author Score, Signal Score, Timing Score)
```

Portfolio-Allokation:
- Score 96 → 4.2× expected growth → 35% VP
- Score 88 → 3.6× growth → 25% VP
- Score 84 → 3.0× growth → 20% VP
- Score 70 → 1.5× growth → 10% VP

**Voraussetzung:** Author-level sp_per_vp-History über min. 10 Votes pro Autor.
Aktuell: nur 8 Autoren mit ≥ 5 Datenpunkten. Ziel: 20–30 Autoren mit je 10+ Votes.

**Timeframe:** Datenbasis ausreichend ca. August/September 2026.
