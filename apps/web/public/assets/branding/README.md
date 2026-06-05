# VoteBroker Branding

**Brand Direction: A2 — Active Hub · Signal Processing** (v1.0, eingefroren / produktionsreif)

Komplettes Marken-Asset-System. Identische Kopie unter `apps/web/public/assets/branding/`.

## Struktur

```
docs/branding/
├── brand-guide.html         ← Brand Guide (interaktiv, im Browser öffnen)
├── brand-guide.md           ← Brand Guide (Markdown)
├── votebroker-tokens.css    ← Design-Tokens (Palette, Typo, Spacing)
├── landing-integration.html ← Drop-in Module: Header, Hero, Netzwerk-Hintergrund
│
├── logo/                    ← Logo & Icon
│   ├── logo-master.svg/.png        Standard horizontal
│   ├── logo-dark / -light          dunkel / hell
│   ├── logo-mono-light / -dark     einfarbig
│   ├── logo-animated.svg           animiert (nur Web/App)
│   ├── logo-stacked / -dark        gestapelt
│   ├── icon.svg / icon-animated.svg  nur Mark
│   └── app-dashboard-mark.png
│
├── favicon/                 ← Favicon & PWA
│   ├── favicon.ico                 multi-res (16/32/48/64)
│   ├── favicon-16/32/48/64.png
│   ├── apple-touch-icon.png        180×180
│   ├── pwa-192 / pwa-512 / pwa-512-maskable.png
│   ├── site.webmanifest
│   └── head-snippet.html           <head>-Tags zum Einfügen
│
├── social/                  ← Avatare
│   ├── avatar-steemit.png          400×400
│   ├── avatar-github.png           420×420
│   ├── avatar-twitter.png          400×400
│   └── avatar-linkedin.png         400×400
│
└── app/                     ← App-Lockups
    ├── app-header.svg/.png / -animated
    ├── app-sidebar.svg
    ├── app-dashboard.svg / -animated
    └── app-login.svg
```

## Integration in die bestehende Landingpage

1. `votebroker-tokens.css` einbinden (Palette/Typo/Spacing als CSS-Variablen).
2. Poppins laden: `<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@200;400;500;700;800&display=swap" rel="stylesheet">`
3. `<head>`-Tags aus `favicon/head-snippet.html` übernehmen, `site.webmanifest` nach `/site.webmanifest` legen.
4. Module aus `landing-integration.html` (Header, Hero, Netzwerk-Hintergrund) schrittweise übernehmen — die Klassen sind unter `.vb-` isoliert und kollidieren nicht mit Bestandscode.
5. Altes Branding ersetzen: Logo-Referenzen auf `logo/logo-master.svg` bzw. `logo/icon.svg` umstellen.

## Regenerierung

Quell-Skripte unter `build/`:
- `mark.py` — Geometrie + PNG-Rasterizer (Single Source of Truth)
- `gen_svg.py` — alle SVG-Lockups
- `gen_png.py` — alle PNG-Assets
- `icon-master.svg` / `icon-animated.svg` — kanonische SVGs
