---
title: "VoteBroker Devlog — 7. Juni 2026"
date: 2026-06-07
type: devlog-post
status: draft
---

# VoteBroker Devlog — 7. Juni 2026

---

## Eine strategische Weichenstellung

Wir hören eure Fragen — und sie drehen sich zunehmend um dasselbe Thema: Wie findet man auf Steem die Autoren, die es wirklich wert sind, unterstützt zu werden? Wie setzt man seine Voting Power sinnvoll ein, wenn man nicht täglich stundenlang die Community durchforstet?

Das ist keine Frage nach Gewinnmaximierung. Das ist die Kernfrage jeder ernsthaften Kuration: **Qualität finden, bevor alle anderen sie finden.**

VoteBroker war bisher ein Werkzeug, das Votes ausführt. Was es werden soll, ist ein Werkzeug, das beim Finden hilft — und das Ausführen dann strukturiert übernimmt. Der Weg dorthin führt durch eine saubere Datenbasis. Die bauen wir gerade.

---

## Signal Layer — Die Datenbasis, die wir aufbauen

Gute Empfehlungen entstehen nicht aus Bauchgefühl. Sie entstehen aus Mustern — und Muster brauchen Daten.

In den letzten Wochen haben wir damit begonnen, historische Blockchain-Aktivitäten systematisch auszuwerten. Konkret: Wir analysieren, welche Autoren auf Steem über längere Zeiträume hinweg von erfahrenen, aktiven Kuratoren konsistent beachtet werden. Wir schauen, welche Communities dabei regelmäßig im Mittelpunkt stehen. Und wir schauen auf das *Wann* — in welchen Zeitfenstern nach Veröffentlichung die Aufmerksamkeit typischerweise eintrifft.

Aus diesen Rohdaten berechnen wir täglich drei Typen von Signalen:

- **Autor-Qualität** — Wie konsistent ist ein Autor? Wie oft erhält er Aufmerksamkeit von kuratierungserfahrenen Accounts? Wie entwickelt sich das über die Zeit?
- **Community-Profil** — Welche Communities zeigen eine lebendige, engagierte Kuration? Wo ist die Qualitätsdichte am höchsten?
- **Timing-Muster** — Zu welchen Zeitpunkten nach Veröffentlichung ist Engagement besonders aktiv?

Was wir dabei bewusst *nicht* bauen, ist ein Arbitrage-System. Es geht nicht darum, einen Voting-Vorteil gegenüber anderen herauszuarbeiten. Es geht darum, Autoren zu finden, die gute Arbeit leisten und Unterstützung verdienen — und das früh genug zu erkennen, um sinnvoll Kuration beitragen zu können.

Die technische Grundlage dafür läuft seit einigen Tagen. Aktuell haben wir **223.000+ historische Datenpunkte** gesammelt und daraus bereits erste Signale für **144 Autoren** und **38 Communities** berechnet. Das wächst täglich.

Diese Signale sind derzeit noch rein intern — wir werten aus, wie stabil und aussagekräftig sie sind, bevor wir sie in die DNA-Vorschläge einbauen. Qualität vor Geschwindigkeit.

---

## VP-Budget: Vollständig in 14 Sprachen

Die im letzten Update eingeführte VP-Budget-Zeile im Dashboard — täglicher VP-Verbrauch, Regenerationsrate und nachhaltige Votes pro Tag — ist jetzt vollständig in allen 14 unterstützten Sprachen verfügbar. Wer das Dashboard auf Japanisch, Polnisch, Türkisch oder einer der anderen elf Sprachen nutzt, sieht jetzt korrekt übersetzte Bezeichnungen statt der englischen Fallbacks.

---

## Änderungen heute

- **i18n vollständig** — 10 VP-Budget-Keys in alle 12 fehlenden Locales nachgezogen (ES, KO, ZH, RU, PT, PCM, ID, HI, BN, JA, TR, PL). VoteBroker ist jetzt in 14 Sprachen lückenlos.
- **Community-Screenshot erneuert** — Der Landingpage-Screenshot der Community-Ansicht zeigt jetzt den aktuellen Stand der Oberfläche in beiden Sprach-Varianten (DE + EN).

---

## Community-Aktivität

Heute (2026-06-07):

- **37** Vote-Versuche ausgeführt
- **9** Autoren unterstützt: @udabeu, @supportive, @blacks, @winkles, @blackeyedm, @successgr, @dodoim, @goodhello und weitere
- **1** aktiver Kurator

---

## Was als Nächstes kommt

- **Signal Layer → DNA-Vorschläge** — Autor-Qualität und Community-Profil direkt bei der Vorschlags-Anzeige sichtbar machen
- **Shadow Mode** (frühestens Juli) — simuliert rückwirkend, welche Autoren der VoteBroker empfohlen hätte; braucht noch 3–4 Wochen weitere Datenakkumulation
- **Community Spotlight** — bezahlte Sichtbarkeit für Autoren, strikt getrennt von organischen Qualitätssignalen

---

*VoteBroker — Community Curation auf Steem · [votebroker.org](https://votebroker.org)*
