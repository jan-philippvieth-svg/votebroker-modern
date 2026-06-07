---
title: "VoteBroker Devlog — 7. Juni 2026"
date: 2026-06-07
type: devlog-post
status: draft
---

# VoteBroker Devlog — 7. Juni 2026

---

## Von Vote-Executor zur Curation Intelligence Platform

Viele von euch stellen die gleichen Fragen: Welche Autoren performen langfristig? Wann lohnt es sich zu voten? Wie setzt man seine Voting Power so ein, dass sie tatsächlich etwas bewirkt — und dabei auch sinnvoll arbeitet?

Das sind legitime Fragen. Wer Voting Power in die Hand nimmt, will sie gut einsetzen. Bessere Curation Rewards sind dabei kein schmutziges Ziel — sie sind ein Indikator dafür, dass die eigenen Entscheidungen funktionieren.

VoteBroker hat bisher Votes ausgeführt und strukturiert. Das bleibt ein Baustein. Aber wir entwickeln das Projekt gerade in eine andere Richtung: weg vom reinen Vote-Executor, hin zu einer **Curation Intelligence Platform**.

Die Ausführung ist das Ende der Kette. Der eigentliche Wert entsteht früher — beim Verstehen. Welche Signale sagen langfristig erfolgreiche Kuration voraus? Welche Muster erkennen erfahrene Kuratoren, die andere übersehen? Was unterscheidet Autoren, die konsistent performen, von denen, die es nur kurzzeitig tun?

Dieses Verständnis aufzubauen ist das Fundament für alles, was wir danach bauen wollen: Vote-DNA, Community Discovery, Timing Intelligence, Shadow Mode, und später einen CoPiloten, der aktiv Vorschläge macht, die auf echten Daten basieren.

---

## Signal Layer — Die Datenbasis, die wir gerade aufbauen

Gute Entscheidungen brauchen gute Daten. Deshalb haben wir in den letzten Wochen damit begonnen, historische Blockchain-Aktivitäten systematisch auszuwerten.

Unser Ziel dabei ist nicht kurzfristige Arbitrage oder das Ausnutzen einzelner Reward-Lücken. Unser Ziel ist es, die Signale zu verstehen, die langfristig erfolgreiche Kuration ausmachen. Wenn daraus bessere Curation Rewards entstehen, ist das kein Nebeneffekt — sondern ein Hinweis darauf, dass die zugrunde liegenden Signale funktionieren.

Konkret: Wir analysieren, welche Autoren auf Steem über längere Zeiträume hinweg von erfahrenen, aktiven Kuratoren konsistent beachtet werden. Wir schauen, welche Communities dabei regelmäßig im Mittelpunkt stehen. Und wir schauen auf das *Wann* — in welchen Zeitfenstern nach Veröffentlichung die Aufmerksamkeit typischerweise eintrifft.

Aus diesen Rohdaten berechnen wir täglich drei Typen von Signalen:

- **Autor-Performance** — Wie konsistent performt ein Autor über Zeit? Wie oft wird er von erfahrenen Kuratoren früh beachtet? Wie entwickelt sich das?
- **Community-Profil** — Welche Communities zeigen langfristig starke Kuration? Wo ist die Signaldichte am höchsten?
- **Timing Intelligence** — Zu welchen Zeitpunkten nach Veröffentlichung findet typischerweise aktive, qualitätsorientierte Kuration statt?

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

- **Signal Layer → DNA-Vorschläge** — Autor-Performance und Timing-Signale direkt bei der Vorschlags-Anzeige sichtbar machen
- **Shadow Mode** (frühestens Juli) — simuliert rückwirkend, welche Entscheidungen der VoteBroker empfohlen hätte; braucht noch 3–4 Wochen weitere Datenakkumulation
- **Community Spotlight** — bezahlte Sichtbarkeit für Autoren, strikt getrennt von organischen Qualitätssignalen

---

*VoteBroker — Curation Intelligence für Steem · [votebroker.org](https://votebroker.org)*
