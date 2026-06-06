# VoteBroker Autopilot — Architektur & Phasenplan

**Stand:** 2026-06-06  
**Status:** Konzept / Noch kein produktiver Code  
**Scope:** Eigenständiges Premium-Modul, vollständig getrennt vom bestehenden DNA-System

---

## 1. Datenbasis-Analyse

### 1.1 Verfügbare Daten (Stand heute)

| Tabelle | Zeilen | Inhalt | Qualität |
|---|---|---|---|
| `audit_events` | 733 | Alle Vote-Versuche mit Timestamp, Author, Permlink, Weight | ✅ Vollständig |
| `vb_vote_outcomes` | 181 | User-Ebene: voted_at, weight_bps, realized_sp | ⚠️ 49/181 mit realized_sp |
| `vb_global_vote_outcomes` | 294 | Reichste Tabelle: Post-Metadata, vote_delay_minutes, vp_at_vote_bps, strategy_category | ⚠️ Lückenhaft (s.u.) |
| `vb_whale_author_signals` | 812 | 132 Autoren × 35 Whales: Timing-Muster, avg_vote_delay, Payout-Daten | ✅ Gut strukturiert |
| `strategy_rules` | 3 | JSON-Regelwerk pro User | ✅ Vorhanden |

**Zeitfenster:** Nur 6 Tage Daten (31.05. – 06.06.2026). Für Shadow Mode werden **mindestens 30 Tage** benötigt.

### 1.2 Lücken und Qualitätsprobleme

| Feld | Status | Impact |
|---|---|---|
| `realized_curation_sp` | 21/294 Einträge (7%) — Payouts dauern 7 Tage, Daten wachsen täglich | Shadow Mode braucht ~4 Wochen Vorlauf |
| `vp_at_vote_bps` | 116/294 (39%) — VP-Snapshot zum Vote-Zeitpunkt fehlt oft | VP-Kurvenmodell unvollständig |
| `vote_value_sbd` | Fast vollständig null | Keine historische USD-Bewertung pro Vote |
| `post_pending_payout_sbd` | Null in global_outcomes | Kein direkter Post-Wert zur Entscheidungszeit |
| VP-Zeitreihe | Nicht gespeichert | Keine kontinuierliche Kurve, nur Snapshot-Werte |
| Konkurrenz-Curatoren | Nicht erfasst | Wer hat vor/nach uns gevoted? (crit. für Timing) |
| Post-Qualitätssignal | Nur Whale-Signale | Kein eigenes Relevanz-Scoring |
| Historische Preise | Nicht gespeichert | SBD/STEEM-Preis zum Zeitpunkt jedes Votes fehlt |

### 1.3 Abgeleitete Metriken (heute bereits möglich)

Aus den vorhandenen Daten lassen sich direkt berechnen:

- **VP-Verbrauchsrate** — weight_bps-Summe pro Tag / 24h → Regen-Gleichgewicht sichtbar
- **Voting-Effizienz** — realized_sp / weight_bps (wo Payouts vorliegen)
- **Timing-Verteilung** — vote_delay_minutes-Histogramm (min: 6min, max: 167h, Ø 45h — breite Streuung)
- **Strategie-Kategorien-Performance** — Ø realized_sp nach `strategy_category` (niedrig/normal/bevorzugt/lieblingsautor)
- **Whale-Overlap** — % der eigenen Votes, wo Whale vorher/nachher voted hat
- **VP-Effizienzindex** — tatsächliche VP-Ausgabe vs. theoretisches Tagesbudget (5% Regen)
- **Author-ROI** — realized_sp / vote_weight pro Autor (sobald Payouts vollständig)

---

## 2. Fehlende Dateninfrastruktur

Für den Autopilot sind folgende Erweiterungen notwendig, **bevor Phase 2 beginnt:**

### 2.1 VP-Zeitreihe (`vb_vp_snapshots`)
```sql
CREATE TABLE vb_vp_snapshots (
  username       TEXT NOT NULL,
  sampled_at     TEXT NOT NULL,
  vp_bps         INTEGER NOT NULL,
  PRIMARY KEY (username, sampled_at)
);
```
Sampling-Intervall: alle 15 Minuten per Cron.  
Zweck: VP-Kurve rekonstruieren, optimalen Vote-Zeitpunkt berechnen.

### 2.2 Post-Curation-Fenster (`vb_post_timing`)
Aus `get_content` + `get_active_votes` beim Payout: Wann wurde gevoted, was kam raus?  
Ermöglicht: "Autor X sollte zwischen Minute 15–45 nach Publish gevoted werden."

### 2.3 Konkurrenz-Snapshot bei Vote
Beim Vote-Zeitpunkt: Wie viele Curatoren haben bereits gevoted? Welche Whales?  
Feld `competition_vote_count` in `vb_global_vote_outcomes` nachpflegen.

### 2.4 Historische Preise (`vb_price_history`)
```sql
CREATE TABLE vb_price_history (
  sampled_at   TEXT PRIMARY KEY,
  sbd_usd      REAL,
  steem_usd    REAL
);
```
Täglich 1 Eintrag reicht für Backtesting.

---

## 3. Phasenplan mit Aufwandsschätzung

### Phase 1 — Datenbasis (dieses Dokument)
**Aufwand:** 0 Entwicklungstage (Analyse abgeschlossen)  
**Voraussetzung für Phase 2:** 30 Tage laufende Datenpipeline + VP-Zeitreihe sammeln

---

### Phase 2 — Shadow Mode

**Ziel:** "Was hätte der Autopilot getan?" — kein echter Vote, nur Simulation.

**Kernlogik:**
```
Für jeden Tag in den letzten 30 Tagen:
  Gegeben: VP-Kurve, Strategie-Regeln, verfügbare Posts (aus Audit-Log)
  Simuliere: Optimaler Vote-Zeitpunkt, optimales Gewicht
  Vergleiche: Simulierte Curation vs. tatsächliche Curation
  Ausgabe: Delta in SP und %
```

**Datenmodell:**
```sql
CREATE TABLE vb_autopilot_shadow (
  username         TEXT NOT NULL,
  date_str         TEXT NOT NULL,
  manual_votes     INTEGER,
  manual_sp        REAL,
  manual_vp_spent  REAL,
  sim_votes        INTEGER,
  sim_sp           REAL,
  sim_vp_spent     REAL,
  delta_sp         REAL,      -- sim_sp - manual_sp
  delta_pct        REAL,      -- delta_sp / manual_sp * 100
  computed_at      TEXT,
  PRIMARY KEY (username, date_str)
);
```

**Voraussetzungen:**
- `realized_curation_sp` für ≥100 Votes vorhanden (ca. 4 Wochen ab heute)
- VP-Zeitreihe ≥14 Tage
- Timing-Modell (optimal vote delay pro Autor/Kategorie)

**Aufwand:** 5–8 Entwicklungstage  
Backend-Job: 2d · Shadow-Algorithmus: 3d · Dashboard-Karte: 2d

---

### Phase 3 — Autopilot Score

**Drei Scores, je 0–100:**

| Score | Formel | Basis |
|---|---|---|
| **Voting Effizienz** | realized_sp / (weight_bps_total / 10000 * vote_usd) | vb_vote_outcomes |
| **DNA Strategie** | Abdeckung aktiver Strategie-Autoren × Timing-Güte | strategy_rules + vote_delay |
| **Autopilot Prognose** | Shadow-Simulation Delta vs. Durchschnitt aller User | vb_autopilot_shadow |

Score-Tabelle:
```sql
CREATE TABLE vb_autopilot_scores (
  username            TEXT NOT NULL,
  computed_at         TEXT NOT NULL,
  voting_efficiency   INTEGER,
  dna_strategy        INTEGER,
  autopilot_prognosis INTEGER,
  PRIMARY KEY (username, computed_at)
);
```

**Aufwand:** 3–4 Entwicklungstage  
Score-Algorithmen: 2d · Dashboard-Widget: 1–2d

---

### Phase 4 — Premium Gating

**Evaluierte Modelle:**

#### A) Monatliches Abo
- **Preis-Indikation:** 2–5 USD/Monat (Steem-Kontext: sehr preissensitiv)
- **Pro:** Planbar, einfach zu implementieren (billing_accounts bereits vorhanden)
- **Con:** Hohe Churn-Rate wenn Mehrwert nicht sofort sichtbar; Shadow Mode muss erst überzeugen
- **Empfehlung:** Sinnvoll ab Phase 5, wenn Autopilot-Beta messbar performt

#### B) Abo mit Free Tier
- Shadow Mode kostenlos (Anreiz zur Nutzung), aktives Auto-Voting hinter Paywall
- **Pro:** Natürlicher Funnel; User sieht den Mehrwert bevor er zahlt
- **Con:** Infrastrukturkosten für Free-Tier-User
- **Empfehlung:** Bevorzugtes Modell — "du siehst was du verpasst, dann zahlst du"

#### C) Performance-Modell (Erfolgsgebühr)
- Autopilot nimmt X% der zusätzlichen Curation als Gebühr
- **Pro:** Kein Upfront-Risiko für User; perfekte Incentive-Ausrichtung
- **Con:** Sehr komplex zu messen und durchzusetzen auf-chain; Edge Cases (Preiswechsel, VP-Einbrüche)
- **Empfehlung:** Langfristig interessant, kurzfristig zu komplex

#### D) Hybrid-Modell
- Basisabo (z.B. 1 USD/Monat) + Performance-Bonus-Feature freigeschaltet ab gewissem SP-Volumen
- **Pro:** Deckt Fixkosten, belohnt Engagement
- **Con:** Komplexe Kommunikation
- **Empfehlung:** Phase 2 des Monetarisierungsmodells, nachdem Abo-Basis steht

**Infrastruktur-Aufwand Gating:** 2–3d (billing_accounts, Consent-Flag, Feature-Gate im API)

---

### Phase 5 — Autopilot Beta

**Trigger:** Shadow Mode zeigt stabil >15% Delta über 30 Tage für ≥3 User.

**Autopilot darf:**
- VP-Zielbereich einhalten (z.B. immer zwischen 80–95% halten)
- Offene Chancen nach Whale-Signal + Timing-Score priorisieren
- Vote-Zeitpunkt optimieren (innerhalb konfigurierbarer Fenster)
- Gewichte dynamisch anpassen (nie über User-definiertes Maximum)

**Autopilot darf niemals:**
- Autoren voten, die nicht in der Strategie sind
- VP unter User-definiertes Minimum senken
- Ohne gültige Session/Consent agieren

**Architektur:**
```
Cron (alle 15min)
  → VP-Check: Liegt VP im Zielbereich?
  → Opportunity-Scan: Offene Posts in Strategie?
  → Score: Timing-Score pro Post (Whale-Overlap, Delay-Optimum)
  → Vote-Queue: Top-N nach Score, innerhalb VP-Budget
  → Execute: Server-Side via Access-Token (SteemConnect) oder Keychain-Queued
  → Log: vb_autopilot_runs
```

**Aufwand:** 8–12 Entwicklungstage (der größte Einzelblock)

---

### Phase 6 — ROI Dashboard

**Kern-KPIs:**

| Kennzahl | Herleitung |
|---|---|
| Zusätzliche Curation durch VoteBroker | realized_sp (VB-Votes) − baseline_sp (ohne Strategie) |
| Performance vs. manuell | vb_autopilot_shadow.delta_pct |
| Zusätzlicher Ertrag letzte 30 Tage | delta_sp × aktueller STEEM-Preis |
| Break-Even-Datum | Abo-Kosten / (delta_sp_pro_tag × STEEM-Preis) |

**Aufwand:** 3–4 Entwicklungstage (Daten liegen durch Phase 2/3 bereits vor)

---

## 4. Gesamtaufwand und Zeitplan

| Phase | Voraussetzung | Entwicklungstage | Wartezeit |
|---|---|---|---|
| 1 — Datenbasis | — | 0 (done) | 30 Tage Datenpipeline |
| Daten-Infra (VP-Zeitreihe, Preishistorie) | Phase 1 | 1–2d | sofort startbar |
| 2 — Shadow Mode | 30d Daten + VP-Reihe | 5–8d | ab ~07.07.2026 |
| 3 — Autopilot Score | Phase 2 | 3–4d | — |
| 4 — Premium Gating | Phase 3 | 2–3d | — |
| 5 — Autopilot Beta | Phase 4 + Validation | 8–12d | nach Shadow-Validation |
| 6 — ROI Dashboard | Phase 5 | 3–4d | — |
| **Gesamt** | | **22–33d** | **frühestens Q3 2026** |

---

## 5. Risiken

| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|
| Zu wenig realized_sp für valides Shadow-Modell | Mittel | Hoch | Mindest-Schwellwert: 100 realized Votes vor Phase 2 |
| Steem-Netzwerk-Latenz unterbricht Auto-Voting | Hoch | Mittel | Retry-Queue + Circuit-Breaker, immer VP-Check vor Vote |
| User deaktiviert Autopilot, Blame für schlechte Performance | Mittel | Hoch | Shadow Mode zuerst — User sieht Potenzial, bevor er aktiviert |
| SteemConnect-Token läuft während Autopilot-Run ab | Mittel | Hoch | Token-Expiry-Check vor jedem Run, User-Benachrichtigung |
| Curation-Optimierung lässt sich nicht von "Botting" unterscheiden | Niedrig | Sehr hoch | Strikte Rate-Limits, nur Strategie-Autoren, vollständige Transparenz im Log |
| Preissensitivität: User zahlt nicht für Autopilot | Mittel | Hoch | Free Shadow Mode als Konversionspfad; Mehrwert erst beweisen |
| Datenbasis zu jung für valide Backtests | Hoch (aktuell) | Mittel | 30-Tage-Gate ist nicht verhandelbar |

---

## 6. Nächste konkrete Schritte

Bevor Phase 2 beginnen kann, müssen zwei Dinge **jetzt gestartet** werden (je ~1 Tag Aufwand):

1. **VP-Zeitreihe sammeln** — Cron alle 15min, schreibt in `vb_vp_snapshots`; je früher gestartet, desto früher ist Phase 2 möglich
2. **Preishistorie sammeln** — Cron 1×/Tag, schreibt in `vb_price_history`

Beides sind reine Backend-Jobs ohne UI und ohne Eingriff in bestehende Logik.

---

*VoteBroker Autopilot — internes Konzeptdokument*
