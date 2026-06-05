# VoteBroker — Brand Guide

**Brand Direction:** A2 — Active Hub · Signal Processing
**Version:** 1.0 (Produktionsreif / eingefroren)

VoteBroker steht für Community Intelligence, Signal-Analyse und Curation-Networking im Steem-Ökosystem. Das Logo zeigt einen aktiven zentralen Hub, in dem Signale zusammenlaufen und verarbeitet werden — nicht Industrie, nicht Trading-Bot, nicht generisches Krypto.

---

## 1. Das Logo

Das Markenzeichen ist ein Signal-Netzwerk: ein dominanter, leuchtender zentraler Hub mit Doppelring, drei oberen Knoten, die ein subtiles umgedrehtes „V" (für VoteBroker) bilden, und einem Ring ruhiger Satelliten-Knoten. Der Hub wirkt aktiv durch Glow, Doppelring und (im Web) wandernde Signalpulse.

### Varianten

| Variante | Datei | Verwendung |
|---|---|---|
| Master (horizontal) | `logo/logo-master.svg` | Standard, transparenter Hintergrund |
| Dark | `logo/logo-dark.svg` | Auf dunklen Flächen |
| Light | `logo/logo-light.svg` | Auf hellen Flächen |
| Mono hell | `logo/logo-mono-light.svg` | Einfarbig weiß (dunkler Grund) |
| Mono dunkel | `logo/logo-mono-dark.svg` | Einfarbig schwarz (heller Grund) |
| Animiert | `logo/logo-animated.svg` | Nur Web/App |
| Gestapelt | `logo/logo-stacked.svg` | Quadratische Kontexte |
| Icon | `logo/icon.svg` | Ohne Wortmarke |
| Icon animiert | `logo/icon-animated.svg` | Nur Web/App |

---

## 2. Farbpalette

Alle Farben sind direkt aus dem Logo abgeleitet.

### Primärfarben
| Farbe | Hex | Rolle |
|---|---|---|
| Navy 900 | `#0B1020` | Primärer Hintergrund |
| Primary Blue | `#2563EB` | Hauptaktion, Hub-Ring |
| Cyan 400 | `#00D4FF` | Aktiver Kern, Highlight, Fokus |

### Sekundärfarben
| Farbe | Hex | Rolle |
|---|---|---|
| Navy 800 | `#0F1A2E` | Erhöhter Hintergrund |
| Navy 700 | `#141E35` | Kartenfläche |
| Node BG | `#0d1424` | Knoten-Füllung im Icon |
| Blue 500 | `#378ADD` | Sekundärblau, rechter Arm |
| Blue 300 | `#93C5FD` | Weicher Puls |
| Cyan 300 | `#67E8F9` | Heller Signalpuls |

### Akzente (sparsam einsetzen)
| Farbe | Hex | Rolle |
|---|---|---|
| Purple | `#7C3AED` | Vote-DNA Sub-Brand |
| Mint | `#5DCAA5` | Seltener Datenakzent |
| Success | `#22C55E` | Positive Werte |
| Warning | `#F59E0B` | Warnungen |
| Danger | `#EF4444` | Fehler |

### Text
| Farbe | Hex | Rolle |
|---|---|---|
| Text 100 | `#E2EBF0` | Primärtext auf dunkel |
| Text 300 | `#B8CADF` | Sekundärtext |
| Text 500 | `#7C9BBF` | Gedämpft / Tagline |
| Text 700 | `#4B6080` | Labels / schwach |
| Ink | `#0B1020` | Text auf hellen Flächen |

### Verläufe
- **Brand:** `linear-gradient(90deg, #2563EB → #00D4FF)` — für „BROKER", Buttons
- **Brand 3:** `linear-gradient(120deg, #2563EB → #7C3AED → #00D4FF)` — Hero-Akzente
- **Hub Glow:** `radial-gradient(rgba(0,212,255,0.3) → rgba(37,99,235,0) )`

---

## 3. Typografie

**Primärschrift: Poppins** (geometrische Sans, Enterprise-/SaaS-Charakter).
Fallback-Stack: `"Poppins", "Segoe UI", system-ui, -apple-system, Arial, sans-serif`.

### Wortmarke
„VOTE" in **Light (200)**, „BROKER" in **Black (800)** mit Brand-Verlauf. Negatives Tracking (-0.02em).

### Gewichte
| Gewicht | Wert | Verwendung |
|---|---|---|
| Light | 200 | Display-Headlines, „VOTE" |
| Regular | 400 | Fließtext |
| Medium | 500 | Navigation, Labels |
| Bold | 700 | Betonung |
| Black | 800 | „BROKER", Hero-Akzent |

### Typografie-Skala (1.250 — Große Terz)
`0.64 · 0.8 · 1 · 1.25 · 1.563 · 1.953 · 2.441 · 3.052 rem`

- Taglines / Labels: Tracking `0.18em`, Großbuchstaben
- Display: Tracking `-0.02em`

---

## 4. Abstände

8-Punkt-Raster. Token: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 px`.

Vertikaler Rhythmus in `rem` (1 / 1.5 / 2 rem), komponenteninterne Abstände in `px`.

### Radien
`sm 6px · md 10px · lg 16px · xl 24px · full 9999px`

---

## 5. Logo-Schutzraum

Der Mindest-Schutzraum rund um das Logo entspricht der **Höhe des Hub-Kerns** (das „x"-Maß). Innerhalb dieses Bereichs dürfen keine anderen Elemente, Text oder Bildkanten liegen.

- Mindestbreite Wortmarke-Lockup: **120px** (digital)
- Mindestgröße Icon allein: **24px**
- Unterhalb von 32px: vereinfachte Variante (Hub + 3 obere Knoten, ohne Satelliten-Ring)

---

## 6. Icon-Verwendung

**Erlaubt**
- Icon allein als App-/Favicon-/Avatar-Mark
- Auf Navy-, dunklen oder hellen Flächen (passende Variante wählen)
- Animierte Version nur in Web/App-Kontexten

**Nicht erlaubt**
- Logo verzerren, drehen oder spiegeln (das umgedrehte V ist bewusst gesetzt)
- Farben des Verlaufs verändern
- Glow/Pulse so verstärken, dass ein „Gaming"-Look entsteht
- Auf unruhigen Foto-Hintergründen ohne abdunkelnde Fläche platzieren
- Zahnrad oder andere Industrie-Motive hinzufügen

---

## 7. Animation

Nur für Website und App. Niemals in statischen Exporten (Favicon, Print, Avatar).

- **Signalpulse** wandern entlang der drei Hauptkanten nach innen zum Hub („Informationen laufen zusammen")
- **Doppelte konzentrische Ringe** strahlen rhythmisch vom Hub aus
- **Atmender Kern** — leichte Größen-/Helligkeitspulsation
- Dauer ~3.4s, weiche Easing-Kurven, sehr subtil
- Stil: SaaS / Enterprise — kein Gaming, kein Neon-Flackern
- Respektiert `prefers-reduced-motion`: Animation wird vollständig deaktiviert

---

## 8. Markenhaltung

Das Logo soll wirken wie: **Intelligence · Signal Processing · Community Discovery · Curation Network.**

Es soll *nicht* wirken wie: Trading-Bot · Krypto-Coin · 0815-AI-Startup · Industrie/Maschinenbau.
