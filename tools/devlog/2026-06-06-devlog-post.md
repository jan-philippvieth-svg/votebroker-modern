---
title: "VoteBroker Devlog — 6. Juni 2026"
date: 2026-06-06
type: devlog-post
status: draft
---

# VoteBroker Devlog — 6. Juni 2026

---

## Änderungen seit dem letzten Devlog

**DNA-Tab — Visuelle Prozessleiste „So funktioniert VoteBroker"**
Der DNA-Tab zeigt jetzt oben eine kompakte Journey-Leiste mit vier Schritten: Community aufbauen → Vote-DNA analysieren → Strategie generieren → Dashboard nutzen. Jeder Schritt hat eine große Icon-Box mit Farb-Gradient, eine nummerierte Badge und eine kurze Beschreibung. Sichtbare Pfeile zwischen den Schritten visualisieren den Workflow. Ein Lightbulb-Tipp-Panel darunter erklärt das Kern-Prinzip: Community und DNA sind die Basis — alles andere folgt daraus.

Die bisherigen Kurator-Typ-Labels ("Strategischer Gewichts-Voter", "Alles gevotet" etc.) wurden vollständig entfernt. Das Dashboard klassifiziert Nutzer nicht mehr — es führt sie durch einen klaren Prozess.

**Landingpage — Neuer Abschnitt „So funktioniert VoteBroker"**
Zwischen den Feature-Cards und den Screenshots gibt es jetzt einen eigenen Workflow-Abschnitt. Besucher sehen in fünf Sekunden den gesamten Curation-Prozess: vier Schritt-Karten nebeneinander, gleiche visuelle Logik wie der App-Bereich, aber großzügiger und marketing-tauglich.

**Sicherheitstext präzisiert — Auth-Architektur korrekt kommuniziert**
Die Landingpage beschreibt jetzt korrekt, wie Credentials tatsächlich behandelt werden:

> Keys lokal. Tokens serverseitig. Keine Steem-Credentials im Browser.

Posting-Keys verlassen via Keychain nie den Browser. SteemConnect-Access-Tokens werden serverseitig gespeichert, nicht an den Client zurückgegeben.

**Login — Keychain und SteemLogin immer sichtbar**
Bisher wurde die Keychain-Option im Login nur angezeigt, wenn die Extension innerhalb von 2 Sekunden erkannt wurde. Ab sofort sind beide Wege immer sichtbar: Keychain-Status wird als Hinweis unterhalb des Buttons angezeigt — grün wenn erkannt, amber mit Installationshinweis wenn nicht. Klickt jemand auf Keychain ohne Extension, erscheint eine klare Fehlermeldung statt stillem Abbruch.

**Dashboard — 7-Tage-Verlauf ersetzt Pending-Karte**
Die mittlere Dashboard-Karte zeigt jetzt eine kompakte Tabelle mit den letzten 7 Tagen: Votes, Autoren und erwartete Curation pro Tag. Darunter eine Aggregat-Zeile mit Gesamt-Votes, eindeutigen Autoren, Gesamt-Curation, Ø Curation pro Vote sowie dem besten Tag der Woche. Die tägliche Frage „Wie lief es gestern und vorgestern?" ist damit direkt beantwortbar.

**DNA-Tab — Gestatus nach Vote-Ausführung korrigiert**
Nach dem Voten und einem Tab-Wechsel wurden die bereits ausgeführten Votes im DNA-Tab noch als offene Einträge angezeigt. Der Fehler lag im Lifecycle: beim Zurückwechseln in den Tab wurde der Plan neu initialisiert. Ab sofort wird der Plan nach erfolgreicher Ausführung dauerhaft geleert — ein Rückwechseln zeigt keine Ghost-Votes mehr.

**Autopilot-Daten-Infrastruktur**
VoteBroker erfasst jetzt pro Vote ein vollständiges Daten-Profil:
- **VP vor dem Vote** — gemessen direkt vor dem Broadcast
- **VP nach dem Vote** — aus dem Post-Broadcast-Account-Stand
- **Vote-Wert in SBD** — berechnet über die Reward-Fund-Formel
- **Community** — aus den Post-Metadaten extrahiert

Zusätzlich werden alle 15 Minuten VP-Snapshots aller aktiven Sessions gespeichert sowie täglich die aktuellen STEEM- und SBD-Preise von CoinGecko. Diese Datenbasis ist die Grundlage für spätere Effizienzanalysen: „Lohnen sich 20 Votes mit 5% mehr als 5 Votes mit 20%?"

**Signal Layer — historische Blockchain-Daten**
VoteBroker scannt jetzt rückwirkend die Vote-Historie bekannter Whale-Accounts (90 Tage, 60+ Accounts via `get_account_history`). Für jeden erfassten Post werden nachgelagert finale Payouts und Timing-Daten abgerufen. Täglich werden daraus vier Signale berechnet:

- **Author Quality Score** — durchschnittlicher Post-Payout, Whale-Aktivität, Konsistenz
- **Whale Follow Rate** — wie oft folgen bekannte Großkuratoren auf einen Autor?
- **Community Yield Score** — welche Communities bringen die höchste Curation-Rendite?
- **Vote Timing Score** — in welchem Zeitfenster nach Veröffentlichung voten die Whales typischerweise?

Diese Signale sind die geplante Grundlage für das DNA-System und den späteren Autopiloten — beide sollen auf demselben Signal Layer aufbauen.

**Realized Curation — automatische tägliche Aktualisierung**
Bisher wurden realisierte Curation-Erträge nur manuell über einen Admin-Trigger erfasst. Ab sofort läuft täglich um 04:00 UTC ein automatischer Rebuild: er scannt die Blockchain nach `curation_reward`-Operationen für alle aktiven Nutzer und gleicht sie mit den gespeicherten Votes ab. Zusätzlich werden finale Post-Payouts für abgeschlossene Beiträge nachgepflegt. Das Dashboard zeigt damit immer den aktuellsten Stand der tatsächlich erzielten Erträge.

**VP-Budget-Analyse**
Das Dashboard zeigt jetzt eine kompakte Budget-Zeile: täglicher VP-Verbrauch, Regenerationsrate, Netto-Balance und die nachhaltige Anzahl von Votes pro Tag beim aktuellen durchschnittlichen Gewicht. Ein Statusindikator zeigt auf einen Blick, ob das VP-Level gerade steigt, stabil bleibt oder sinkt.

---

## Community-Aktivität

Heute (2026-06-06):

- **18** Vote-Versuche ausgeführt
- **9** Autoren unterstützt: @tfc-reports, @sa-reports, @ritzy-writer, @raintears, @ocean-trench, @heartwarming, @boc-reports, @blessedlife und weitere
- **1** aktiver Kurator

---

## Was als Nächstes kommt

- **Signal Layer ins DNA-System** — Whale-Follow-Rate und optimales Timing-Fenster direkt beim Autor-Vorschlag anzeigen
- **Shadow Mode** (frühestens Juli) — simuliert was der Autopilot täglich getan hätte; benötigt 30 Tage Daten mit realisierten Curation-Erträgen
- **Community Spotlight** — bezahlte Sichtbarkeit für Autoren, strikt getrennt von organischen Empfehlungen

---

*VoteBroker — Community Curation auf Steem · [votebroker.org](https://votebroker.org)*
