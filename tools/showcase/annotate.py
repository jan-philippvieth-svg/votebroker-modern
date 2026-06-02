"""
VoteBroker Showcase — Image Annotator
=======================================
Fügt nummerierte rote Marker auf Screenshots ein.

Usage:
  python3 annotate.py [input_dir] [output_dir]

Koordinaten: relative Werte 0.0–1.0 des Bildes (unabhängig von Skalierung).
"""

import sys, os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

_dest_env  = os.environ.get("SCREENSHOT_DEST", "")
INPUT_DIR  = Path(sys.argv[1] if len(sys.argv) > 1 else (_dest_env if _dest_env else str(Path(__file__).parent / "output" / "raw")))
# Annotated images go into SCREENSHOT_ANNOTATED_DEST or <input_dir>/../annotated
_ann_env   = os.environ.get("SCREENSHOT_ANNOTATED_DEST", "")
OUTPUT_DIR = Path(sys.argv[2] if len(sys.argv) > 2 else (_ann_env if _ann_env else str(INPUT_DIR.parent / "annotated")))
FONT_BOLD  = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG   = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Marker-Definitionen ────────────────────────────────────────────────────────
# Format: (rel_x, rel_y, "①", "Beschriftung")
# Koordinaten 0.0–1.0 relativ zu Bildbreite/-höhe

MARKERS: dict[str, list[tuple[float, float, str, str]]] = {

    # ── 01: Dashboard — Übersicht ─────────────────────────────────────────────
    "01_dashboard": [
        (0.14, 0.19, "①", "Votes heute"),
        (0.14, 0.27, "②", "Durchläufe"),
        (0.50, 0.46, "③", "Pending 7 Tage"),
        (0.82, 0.46, "④", "Verdient 30 Tage"),
        (0.65, 0.75, "⑤", "VP-Verlauf"),
    ],

    # ── 02: Vote-DNA / Chancen finden ────────────────────────────────────────
    "02_find_votes": [
        (0.11, 0.22, "①", "Kurator-Profil"),
        (0.08, 0.37, "②", "Posts scannen"),
        (0.50, 0.33, "③", "VP jetzt"),
        (0.30, 0.55, "④", "Autoren-Beziehungen"),
    ],

    # ── 03: Vote-Plan ─────────────────────────────────────────────────────────
    "03_vote_plan": [
        (0.09, 0.35, "①", "VP jetzt"),
        (0.50, 0.35, "②", "VP nach Plan"),
        (0.82, 0.35, "③", "VP morgen"),
        (0.13, 0.52, "④", "Autoren-Liste"),
    ],

    # ── 04: Gewichte & Autor-Status ───────────────────────────────────────────
    "04_edit_weights": [
        (0.10, 0.11, "①", "Plan aktualisieren"),
        (0.10, 0.30, "②", "Kategorie-Tag"),
        (0.60, 0.30, "③", "Vote-Status"),
        (0.85, 0.30, "④", "Uhrzeit"),
    ],

    # ── 05: Bestätigung / Runs ────────────────────────────────────────────────
    "05_confirm_votes": [
        (0.09, 0.22, "①", "VP jetzt"),
        (0.09, 0.38, "②", "Votes heute"),
        (0.30, 0.55, "③", "Durchlauf 1"),
        (0.77, 0.40, "④", "VP-Verlauf"),
    ],

    # ── 06: Community ─────────────────────────────────────────────────────────
    "06_community": [
        (0.42, 0.19, "①", "Autor-Radar"),
        (0.75, 0.35, "②", "Entdeckungen"),
        (0.75, 0.52, "③", "Neuer Autor"),
        (0.57, 0.42, "④", "+ Zur Strategie"),
    ],
}

# ── Stil ───────────────────────────────────────────────────────────────────────

CIRCLE_FILL    = (210, 30, 30, 235)
CIRCLE_OUTLINE = (170, 10, 10, 255)
LABEL_BG       = (15, 15, 15, 200)
WHITE          = (255, 255, 255, 255)
CIRCLE_R       = 16      # Basisradius bei 1600px Breite
FONT_NUM_SZ    = 15
FONT_LBL_SZ    = 12
LABEL_PAD      = 5

# ── Annotierungs-Engine ────────────────────────────────────────────────────────

def annotate(src: Path, dst: Path, markers: list[tuple]) -> None:
    img    = Image.open(src).convert("RGBA")
    W, H   = img.size
    scale  = W / 1600

    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw    = ImageDraw.Draw(overlay, "RGBA")

    try:
        fn = ImageFont.truetype(FONT_BOLD, max(10, int(FONT_NUM_SZ * scale)))
        fl = ImageFont.truetype(FONT_REG,  max(9,  int(FONT_LBL_SZ * scale)))
    except OSError:
        fn = fl = ImageFont.load_default()

    r   = max(10, int(CIRCLE_R * scale))
    pad = max(3,  int(LABEL_PAD * scale))
    lw  = max(1,  int(1.5 * scale))

    for (rx, ry, num, label) in markers:
        cx, cy = int(rx * W), int(ry * H)

        # Roter Kreis
        draw.ellipse([cx-r, cy-r, cx+r, cy+r],
                     fill=CIRCLE_FILL, outline=CIRCLE_OUTLINE, width=lw)

        # Nummer zentriert im Kreis
        nb = fn.getbbox(num)
        draw.text((cx - (nb[2]-nb[0])//2 - nb[0],
                   cy - (nb[3]-nb[1])//2 - nb[1]),
                  num, font=fn, fill=WHITE)

        # Label-Box rechts oder links vom Kreis
        lb  = fl.getbbox(label)
        lw2 = lb[2] - lb[0] + 2*pad
        lh  = lb[3] - lb[1] + 2*pad
        gap = max(4, int(5 * scale))

        lx = (cx + r + gap) if (cx + r + gap + lw2 < W - 10) else (cx - r - gap - lw2)
        ly = max(4, cy - lh//2)

        draw.rounded_rectangle([lx, ly, lx+lw2, ly+lh],
                                radius=max(3, int(4*scale)), fill=LABEL_BG)
        draw.text((lx + pad - lb[0], ly + pad - lb[1]),
                  label, font=fl, fill=WHITE)

        # Verbindungslinie
        lx_conn = (cx + r) if lx > cx else (cx - r)
        lx_end  = lx if lx > cx else (lx + lw2)
        draw.line([(lx_conn, cy), (lx_end, ly + lh//2)],
                  fill=CIRCLE_OUTLINE, width=lw)

    result = Image.alpha_composite(img, overlay).convert("RGB")
    result.save(dst, quality=95)
    kb = dst.stat().st_size // 1024
    print(f"  ✓  {dst.name}  ({kb} KB)")

# ── Hauptlauf ─────────────────────────────────────────────────────────────────

print(f"Input:  {INPUT_DIR}")
print(f"Output: {OUTPUT_DIR}")
print()

done = 0
for stem, markers in MARKERS.items():
    src = INPUT_DIR / f"{stem}.png"
    if not src.exists():
        print(f"  ⚠  {stem}.png fehlt — übersprungen")
        continue
    dst = OUTPUT_DIR / f"{stem}_annotated.png"
    annotate(src, dst, markers)
    done += 1

print(f"\n{done}/{len(MARKERS)} Bilder annotiert → {OUTPUT_DIR}")
