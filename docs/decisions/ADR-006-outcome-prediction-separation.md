# ADR-006: Trennung von Post-Outcome, Vote-Outcome und Modell-Vorhersage

**Datum:** 2026-06-22
**Status:** Aktiv — Phase 1 umgesetzt; Phase 2/3 geplant
**Betrifft:** `vb_global_vote_outcomes`, `vb_copilot_shadow_runs`, `vb_whale_vote_details`, neue `vb_post_outcomes`

---

## Kontext

Heute vermischt `vb_global_vote_outcomes` drei fachlich verschiedene Ebenen in einer
Tabelle mit Schlüssel `(voter, author, permlink)`:

1. **Post-Outcome** — Eigenschaften des *Posts*: `final_payout`, `net_votes`,
   `active_votes`, `community`, Payout-Zeitpunkt. Existiert genau **einmal pro Post**.
2. **Vote-Outcome** — Eigenschaften des *Votes*: `realized_curation_sp`, `realized_at`.
   Hängt am konkreten Vote `(voter, author, permlink)`.
3. **Modell-Vorhersage** — was ein *Modell* vorhergesagt hat: `estimated_sp_weight`,
   `estimated_sp_rshares`, `steemworld_estimate_sp` sowie die `v4_*`-Spalten in
   `vb_copilot_shadow_runs`. Pro Modell ein eigener Datensatz.

Folgen der Vermischung:

- **Redundante Speicherung** des Post-Outcomes über drei Pfade
  (`vb_global_vote_outcomes`, `vb_copilot_shadow_runs`, `vb_whale_vote_details`).
- **Mehrfache `get_content`-Calls** für denselben Post in unterschiedlichen Jobs.
- **Schema-Wachstum pro Modell** (`estimated_sp_v3/v4/v5/...`) statt INSERTs.
- **Schwierige Modellvergleiche** — kein gemeinsamer Outcome-Anker.

Zielbild: Ein Post erzeugt genau ein Outcome. Ein Vote erzeugt genau ein Vote-Outcome.
Jedes Modell erzeugt beliebig viele Vorhersagen gegen dieselben echten Ergebnisse.
Das ist die Grundlage für Shadow-Benchmarking, Modell-Kalibrierung, Rankings und Ensembles.

---

## Entscheidung — Phase 1 (umgesetzt)

Einführung der kanonischen Post-Outcome-Tabelle:

```
vb_post_outcomes (author, permlink)
  post_created_at, community, final_payout, net_votes, active_votes,
  paid_at, resolved_at, recorded_at
```

**Strikt additiv:**

- Bestehende Tabellen und Spalten bleiben unverändert; kein Reader wird angefasst.
- Die Vote-Broadcast-Pipeline (`recordVoteAtBroadcast`) wird **nicht** berührt.
- Backfill einmalig aus `vb_global_vote_outcomes` per reiner SQL-Aggregation
  (`GROUP BY author, permlink`), **kein** erneuter Blockchain-Scan.
- Kanonischer Writer `upsertPostOutcome` (Merge-Semantik) +
  `syncPostOutcomesFromGvo` (idempotenter Backfill/Reconcile) in
  `apps/api/src/chain/postOutcomes.ts`.
- Verdrahtung: Backfill bei Startup (`server.ts`) und am Ende von `runPayoutSync`;
  direkter kanonischer Write im Final-Payout-Resolver (Abschnitt C von `payoutSync`),
  der das ohnehin geladene `get_content` wiederverwendet — kein zusätzlicher Chain-Call.

Merge-Semantik: stabile Identitätsfelder (`post_created_at`, `community`, `paid_at`,
`resolved_at`) behalten ihren ersten bekannten Wert; aufgelöste Messwerte
(`final_payout`, `net_votes`, `active_votes`) übernehmen den neuesten Nicht-NULL-Wert.

Validierung (Prod-Volume, read-only Dry-Run): 1112 kanonische Post-Zeilen, 785 mit
`final_payout`, 746 mit `community`; zweiter Lauf idempotent (weiterhin 1112 Zeilen).

---

## Während Phase 1 entdeckte Trennungen (für Phase 2/3, NICHT umgesetzt)

1. **`net_votes` / `active_votes` sind in `vb_global_vote_outcomes` Vote-Zeitpunkt-
   Snapshots, keine gesettleten Post-Outcomes.** Der Backfill übernimmt sie als
   Best-Effort (deshalb dort meist NULL). Der neue Resolver-Write in `payoutSync` C
   füllt die *gesettleten* Werte aus dem Final-`get_content`. Phase 3: Post-Level-Fakten
   nicht mehr aus den Vote-Zeitpunkt-Spalten von gvo ziehen; alternativ aus
   `vb_copilot_shadow_runs.resolved_vote_count / resolved_active_votes_count`.

2. **`paid_at` ist im Backfill ein Proxy** (`MAX(realized_at)` = `curation_reward`-Op-Zeit,
   voter-spezifisch). Der direkte Resolver nutzt `get_content.last_payout`. Phase 2/3:
   `paid_at` durchgängig auf `last_payout` standardisieren.

3. **Drei redundante Post-Outcome-Resolver laden dasselbe `get_content`:**
   `payoutSync` C, `shadowOutcomeResolverJob`, `whaleEnrichment`. Phase 2: alle drei über
   `vb_post_outcomes` deduplizieren (ein `get_content` pro Post pro Settlement-Fenster).

4. **`community` mehrfach gespeichert:** `vb_global_vote_outcomes.post_community`,
   `vb_whale_vote_details.post_community`, `vb_opportunity_cache.community`. Phase 3:
   auf `vb_post_outcomes` konsolidieren.

5. **Modell-Vorhersagen (Phase 2):** neue Tabelle
   `vb_model_predictions (model, voter, author, permlink) → predicted_sp, predicted_rshares,
   would_vote, score, confidence`. Neue Modelle werden zu INSERTs statt ALTER TABLE;
   ersetzt schrittweise `estimated_sp_*` (gvo) und `v4_*` (shadow_runs). Ermöglicht
   Precision/Recall/F1/MAE/RMSE/MAPE/Profit/ROI je Modell mit *derselben* Query gegen
   dieselben Outcomes.

6. **Vote-Outcome bereinigen (Phase 3):** Konsolidierung auf
   `vb_vote_outcomes (voter, author, permlink) → realized_curation_sp, realized_at`,
   sodass Post-, Vote- und Modell-Ebene sauber getrennt sind.

---

## Kompatibilität / Rückbau

Legacy-Spalten werden vorerst weiter gepflegt; bestehende Leser bleiben unverändert.
Altstrukturen werden erst entfernt, wenn die kanonischen Tabellen stabil produktiv laufen.
