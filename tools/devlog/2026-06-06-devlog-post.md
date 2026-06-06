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
Zwischen den Feature-Cards und den Screenshots gibt es jetzt einen eigenen Workflow-Abschnitt. Besucher sehen in fünf Sekunden den gesamten Curation-Prozess: vier Schritt-Karten nebeneinander, gleiche visuelle Logik wie der App-Bereich, aber großzügiger und marketing-tauglich. Der Introtext erklärt die Verbindung: Community-Signale, Voting-Historie und automatische Strategie-Empfehlungen in einem klaren Workflow.

**Sicherheitstext präzisiert — Auth-Architektur korrekt kommuniziert**
Die bisherige Aussage auf der Landingpage lautete: „Nur im lokalen Store — nie serverseitig gespeichert." Das war technisch das Gegenteil der Wahrheit. Nach vollständiger Analyse des Auth-Flows (Keychain-Signaturprüfung, SteemConnect-Callback, `AuthSession`-Typ im Browser) wurde der Text auf die tatsächliche Architektur ausgerichtet:

> Keys lokal. Tokens serverseitig. Keine Steem-Credentials im Browser.

Konkret: Posting-Keys verlassen via Keychain nie den Browser. SteemConnect-Access-Tokens werden serverseitig in SQLite gespeichert und nicht an den Client zurückgegeben. Der Browser erhält ausschließlich den VoteBroker-Session-Token (`{ token, expiry, username, provider }`).

**Inhaltliche Korrekturen (alle 14 Locales)**
Zwei Aussagen auf der Landingpage stimmten nicht mit dem aktuellen Build überein:

- „Dashboard & Empfehlungen nutzen" → **„Dashboard nutzen"** — das Dashboard ist eine Analyse-Übersicht, keine Empfehlungs-Engine
- „Community Pools für kollaborative Curation" → **„Autoren mit einem Klick zur Curation-Strategie hinzufügen"** — Community Pools sind im aktuellen Build nicht implementiert

Beide Korrekturen wurden in allen 14 Locales (DE, EN, ES, KO, ZH, RU, PT, PCM, ID, HI, BN, JA, TR, PL) durchgeführt.

**Screenshot-Pipeline — Container-Sync gefixt**
`capture_landing.py` schrieb die erzeugten Screenshots bisher auf den Host-Pfad des Docker-Volumes — der API-Container sieht diesen Pfad jedoch nicht, weil das Volume direkt auf `/dev/vda1` liegt. Das Script endet jetzt automatisch mit einem `docker cp`-Schritt, der alle aufgenommenen PNGs direkt in den Container synchronisiert.

---

## Community-Aktivität

Heute (2026-06-06):

- **18** Vote-Versuche ausgeführt
- **9** Autoren unterstützt: @tfc-reports, @sa-reports, @ritzy-writer, @raintears, @ocean-trench, @heartwarming, @boc-reports, @blessedlife und weitere
- **1** aktiver Kurator

---

## Was als Nächstes kommt

- Analytics-Auswertung: Welches Zeitfenster nach Veröffentlichung erzielt die besten Curation Rewards? (Daten wachsen täglich durch automatischen Rebuild)
- Per-Author ROI-Analyse aus `vb_vote_outcomes` — welche Autoren bringen die meisten Curation SP pro investiertem Vote-Dollar?
- Community Spotlight: bezahlte Sichtbarkeit für Autoren, strikt getrennt von organischen Empfehlungen

---

*VoteBroker — Community Curation auf Steem · [votebroker.org](https://votebroker.org)*
