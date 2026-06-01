# VoteBroker — Content Drafts

## Zweck

Dieses Verzeichnis enthält **öffentliche Entwürfe**, die automatisch aus dem internen DevLog generiert werden.

Die Entwürfe sind **nicht fertig** und müssen vor der Veröffentlichung manuell überprüft werden.

---

## Struktur

```
docs/
├── devlog/
│   └── YYYY-MM-DD.md          ← Internes Entwicklungsjournal (Quelle der Wahrheit)
│   └── YYYY-MM-DD-*.md        ← Thematische DevLog-Einträge
└── content/
    ├── README.md               ← Diese Datei
    ├── YYYY-MM-DD-product-post.md   ← Entwurf: Produkt-Update für Nutzer
    ├── YYYY-MM-DD-tech-post.md      ← Entwurf: Technischer Beitrag
    └── YYYY-MM-DD-devlog-post.md    ← Entwurf: Behind-the-Scenes-Beitrag
```

---

## Workflow

```
Entwicklung
  → docs/devlog/YYYY-MM-DD.md  (intern dokumentieren)
  → npm run devlog:today        (Entwürfe generieren)
  → docs/content/*             (Entwürfe reviewen)
  → manuell bearbeiten
  → veröffentlichen
```

---

## Inhaltsrichtlinien (Content Safety Rules)

Vor jeder Veröffentlichung **muss** geprüft werden:

### Niemals in öffentlichen Posts enthalten:

- API-Schlüssel oder Tokens jeder Art
- SteemConnect Access Tokens
- Private Session-Tokens
- Posting-Keys (WIF)
- Operator-Tokens
- Private Nutzer-Daten (Usernames nur wenn öffentlich bekannt)
- Rohe Datenbankdumps oder -abfragen mit echten Daten
- Interne IP-Adressen oder Server-Infrastruktur-Details
- Passwörter, Secrets, Credentials
- Vollständige Stack-Traces mit Pfaden

### Sicher zu teilen:

- Architektur-Konzepte (ohne interne Details)
- Technologie-Entscheidungen und deren Begründung
- Feature-Beschreibungen aus Nutzerperspektive
- Performance-Metriken ohne Server-Details
- Code-Beispiele ohne sensible Werte
- Lessons Learned

### Vor der Veröffentlichung prüfen:

- [ ] Keine Secrets/Tokens enthalten?
- [ ] Kein interner Server-Pfad enthalten?
- [ ] Kein privater Nutzer-Datensatz enthalten?
- [ ] Tonalität dem Ziel-Publikum angemessen?
- [ ] Engagement-Prompts vorhanden?
- [ ] Datum und Titel korrekt?

---

## Entwurf-Typen

### `product-post.md`
**Zielgruppe:** VoteBroker-Nutzer, Steem-Community
**Fokus:** Was ändert sich für den Nutzer? Was ist jetzt möglich?
**Ton:** klar, produktbezogen, verständlich

### `tech-post.md`
**Zielgruppe:** Entwickler, technische Entscheider
**Fokus:** Architektur, Implementierungsdetails, Technologie-Entscheidungen
**Ton:** technisch aber lesbar

### `devlog-post.md`
**Zielgruppe:** Menschen, die am Entwicklungsprozess interessiert sind
**Fokus:** Was ist heute passiert? Was hat funktioniert, was nicht?
**Ton:** authentisch, transparent, Builder-Style

---

## Generierung

Entwürfe werden mit folgendem Befehl aus dem DevLog generiert:

```bash
npm run devlog:today
```

Die Entwürfe werden **nie automatisch veröffentlicht**.
Jeder Entwurf trägt den Header `⚠ DRAFT — REVIEW BEFORE PUBLISHING`.
