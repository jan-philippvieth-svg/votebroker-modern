"""
VoteBroker Story-driven Screenshot Capture + Annotation
=========================================================
Robust, timeout-safe, non-blocking.

Jeder Marker muss auf ein DOM-Element zeigen, das im Absatz erwähnt wird.
Fehlt ein Element: Screenshot trotzdem speichern, Marker überspringen,
Warnung ausgeben — nie hängen, nie abbrechen.

Usage:
  SESSION_TOKEN=<token> python3 capture_story.py [output_dir]
  python3 capture_story.py <token> [output_dir]
"""

import sys, os, json
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

import yaml
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright, Page
from secret_guard import scan_text

# ── Konfiguration ──────────────────────────────────────────────────────────────

TOKEN = os.environ.get("SESSION_TOKEN") or (sys.argv[1] if len(sys.argv) > 1 else "")
if not TOKEN:
    print("ERROR: SESSION_TOKEN fehlt.  export SESSION_TOKEN=<token>")
    sys.exit(1)

_dest = os.environ.get("SCREENSHOT_DEST", "")
OUTPUT_DIR = Path(
    sys.argv[2] if len(sys.argv) > 2
    else (_dest or str(Path(__file__).parent / "output" / "raw"))
)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

STORIES_FILE = Path(__file__).parent / "stories.yaml"
NGINX_URL    = "http://172.19.0.3"
API_URL      = "http://172.19.0.2:3000"
VIEWPORT     = {"width": 1600, "height": 1000}

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG  = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

# Session as plain JSON string — injected directly into localStorage
# (NOT double-encoded: React reads JSON.parse(localStorage.getItem(...)))
SESSION_JSON = json.dumps({
    "token":  TOKEN,
    "expiry": "2026-12-31T23:59:59.000Z",
    "user":   {"username": "jan-philippvieth", "provider": "steemconnect"},
})

# ── Ergebnis-Tracking ──────────────────────────────────────────────────────────

@dataclass
class SectionResult:
    id:              str
    screenshot_ok:   bool = False
    annotated_ok:    bool = False
    markers_found:   int  = 0
    markers_total:   int  = 0
    missing_markers: list[str] = field(default_factory=list)
    warnings:        list[str] = field(default_factory=list)

# ── DOM-basierte Navigation (kein get_by_text — Emoji-resistent) ───────────────

_NAV_SCRIPT = """
(function(kw) {
    var btn = Array.from(document.querySelectorAll('button'))
        .find(function(b) { return (b.innerText||'').toLowerCase().includes(kw); });
    if (btn) { btn.click(); return true; }
    return false;
})(%s)
"""

TAB_KEYWORDS = {
    "dna":       ["vote-dna", "dna"],
    "dashboard": ["dashboard"],
    "community": ["community"],
}

def navigate_tab(page: Page, tab: str) -> bool:
    keywords = TAB_KEYWORDS.get(tab, [tab])
    for kw in keywords:
        try:
            clicked = page.evaluate(_NAV_SCRIPT % json.dumps(kw))
            if clicked:
                page.wait_for_timeout(600)
                return True
        except Exception:
            continue
    return False

def run_action(page: Page, action: dict) -> None:
    t  = action.get("type", "")
    ms = action.get("wait_after_ms", 0)

    if t == "wait_ms":
        page.wait_for_timeout(min(action.get("ms", 1000), 8000))
    elif t == "click_text":
        text = action.get("text", "")
        try:
            page.evaluate(_NAV_SCRIPT % json.dumps(text.lower()))
            if ms: page.wait_for_timeout(min(ms, 8000))
        except Exception:
            pass
    elif t == "scroll":
        page.evaluate(f"window.scrollTo(0, {action.get('y', 0)})")
        page.wait_for_timeout(300)

# ── Element-Suche per JavaScript (timeout-safe, Emoji-resistent) ───────────────

_FIND_SCRIPT = """
(function(searchText) {
    var kw = searchText.toLowerCase().trim();
    var tags = ['button','span','div','p','h1','h2','h3','h4','label','a','td','th'];
    var candidates = [];
    tags.forEach(function(tag) {
        Array.from(document.querySelectorAll(tag)).forEach(function(el) {
            var t = (el.innerText || el.textContent || '').trim().toLowerCase();
            // Only leaf-ish elements (not huge containers)
            if (t.length > 0 && t.length < 300) {
                var exact = (t === kw);
                var contains = t.includes(kw);
                if (exact || contains) {
                    var r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && r.top > -50 && r.left > -50
                        && r.top < window.innerHeight + 50) {
                        candidates.push({
                            exact: exact,
                            area: r.width * r.height,
                            x: r.left + r.width / 2,
                            y: r.top + r.height / 2,
                            w: r.width,
                            h: r.height,
                            text: t.slice(0, 60),
                        });
                    }
                }
            }
        });
    });
    if (!candidates.length) return null;
    // Prefer: exact match → smallest containing element (most specific)
    candidates.sort(function(a, b) {
        if (a.exact !== b.exact) return a.exact ? -1 : 1;
        return a.area - b.area;
    });
    return candidates[0];
})(%s)
"""

def find_element(page: Page, find_text: str, fallback: Optional[str] = None) -> Optional[dict]:
    """
    Finds the most specific DOM element containing find_text.
    Returns { x, y, w, h, text } or None.
    Note: page.evaluate() does NOT take a timeout kwarg in this Playwright version.
    """
    for text in ([find_text] + ([fallback] if fallback else [])):
        try:
            result = page.evaluate(_FIND_SCRIPT % json.dumps(text))  # no timeout kwarg
            if result:
                return result
        except Exception:
            continue
    return None

# ── Anchor-Versatz ─────────────────────────────────────────────────────────────

def apply_anchor(cx: int, cy: int, w: int, h: int, anchor: str) -> tuple[int, int]:
    offsets = {
        "center":      (0,       0),
        "top_left":    (-w//3,  -h//3),
        "top_right":   (+w//3,  -h//3),
        "below":       (0,      +h//2 + 10),
        "above":       (0,      -h//2 - 10),
        "below_right": (+w//4,  +h//3),
    }
    dx, dy = offsets.get(anchor, (0, 0))
    return (cx + dx, cy + dy)

# ── Annotation ─────────────────────────────────────────────────────────────────

CIRCLE_FILL    = (210, 30, 30, 235)
CIRCLE_OUTLINE = (170, 10, 10, 255)
LABEL_BG       = (15, 15, 15, 200)
WHITE          = (255, 255, 255, 255)
CIRCLE_R, FONT_NUM_SZ, FONT_LBL_SZ, PAD = 17, 16, 13, 5

def annotate_image(src: Path, markers: list[tuple[int, int, str]]) -> Path:
    img   = Image.open(src).convert("RGBA")
    W, H  = img.size
    scale = W / 1600
    ov    = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw  = ImageDraw.Draw(ov, "RGBA")

    try:
        fn = ImageFont.truetype(FONT_BOLD, max(10, int(FONT_NUM_SZ * scale)))
        fl = ImageFont.truetype(FONT_REG,  max(9,  int(FONT_LBL_SZ * scale)))
    except OSError:
        fn = fl = ImageFont.load_default()

    r   = max(10, int(CIRCLE_R * scale))
    pad = max(3,  int(PAD * scale))
    lw  = max(1,  int(1.5 * scale))

    for (cx, cy, label) in markers:
        cx = max(r+4, min(W-r-4, cx))
        cy = max(r+4, min(H-r-4, cy))

        draw.ellipse([cx-r, cy-r, cx+r, cy+r],
                     fill=CIRCLE_FILL, outline=CIRCLE_OUTLINE, width=lw)

        num, rest = (label.split(" ", 1) + [""])[:2]
        nb = fn.getbbox(num)
        draw.text((cx-(nb[2]-nb[0])//2-nb[0], cy-(nb[3]-nb[1])//2-nb[1]),
                  num, font=fn, fill=WHITE)

        lb   = fl.getbbox(rest)
        lw2  = lb[2]-lb[0] + 2*pad
        lh   = lb[3]-lb[1] + 2*pad
        gap  = max(4, int(5*scale))
        lx   = (cx+r+gap) if (cx+r+gap+lw2 < W-10) else (cx-r-gap-lw2)
        ly   = max(4, cy-lh//2)

        draw.rounded_rectangle([lx, ly, lx+lw2, ly+lh], radius=max(3, int(4*scale)),
                               fill=LABEL_BG)
        draw.text((lx+pad-lb[0], ly+pad-lb[1]), rest, font=fl, fill=WHITE)

    dst = src.parent / src.name.replace(".png", "_story.png")
    Image.alpha_composite(img, ov).convert("RGB").save(dst, quality=95)
    return dst

# ── Haupt-Capture ──────────────────────────────────────────────────────────────

def main():
    with open(STORIES_FILE, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)
    sections = config.get("sections", [])
    print(f"Story-Datei: {STORIES_FILE.name}  ({len(sections)} Sections)")
    print(f"Output:      {OUTPUT_DIR}\n")

    results: list[SectionResult] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = browser.new_context(viewport=VIEWPORT, locale="de-DE",
                                   timezone_id="Europe/Berlin")

        def proxy(route):
            hdrs = dict(route.request.headers)
            hdrs["session"] = TOKEN
            try:
                route.continue_(url=route.request.url.replace(NGINX_URL, API_URL),
                                headers=hdrs)
            except Exception:
                try: route.continue_()
                except Exception: pass

        page = ctx.new_page()
        page.route(f"{NGINX_URL}/api/**", proxy)

        # ── Login ──────────────────────────────────────────────────────────────
        print("Login…")
        page.goto(NGINX_URL, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_timeout(400)
        # Set session string directly — no double-encoding
        page.evaluate(f"localStorage.setItem('votebroker.session', {repr(SESSION_JSON)})")
        page.goto(f"{NGINX_URL}/dashboard", wait_until="domcontentloaded", timeout=25000)

        page.wait_for_timeout(1000)
        try:
            page.wait_for_function(
                "document.body.innerText.includes('jan-philippvieth')",
                timeout=15000,
            )
            print("  ✓ Eingeloggt als @jan-philippvieth\n")
        except Exception:
            # Session nicht bestätigt — trotzdem weiter, aber DOM-Text loggen
            sample = ""
            try:
                sample = str(page.evaluate("document.body.innerText"))[:120].replace("\n"," ")
            except Exception:
                pass
            print(f"  ⚠ Session nicht bestätigt. DOM: {sample!r}")
            print("  ⚠ Weiter — aber Screenshots zeigen möglicherweise die Landing Page.\n")

        page.wait_for_timeout(2000)

        # ── Sections ───────────────────────────────────────────────────────────
        for section in sections:
            sid      = section.get("id", "unknown")
            filename = section.get("filename", sid)
            title    = section.get("title", sid)
            tab      = section.get("tab", "dashboard")
            scroll_y = section.get("scroll_y", 0)
            actions  = section.get("actions", [])
            markers  = section.get("markers", [])

            res = SectionResult(id=sid, markers_total=len(markers))
            results.append(res)
            print(f"── [{sid}] {title}")

            # Tab navigieren
            ok = navigate_tab(page, tab)
            if not ok:
                # Debug: welche Buttons sind sichtbar?
                try:
                    btns = page.evaluate(
                        "Array.from(document.querySelectorAll('button')).map(b=>b.innerText.trim()).filter(t=>t).slice(0,8)"
                    )
                    print(f"  ⚠  Tab '{tab}' nicht gefunden. Sichtbare Buttons: {btns}")
                except Exception:
                    print(f"  ⚠  Tab '{tab}' nicht gefunden")
                res.warnings.append(f"Tab '{tab}' nicht gefunden")

            if scroll_y:
                page.evaluate(f"window.scrollTo(0, {scroll_y})")
                page.wait_for_timeout(300)

            # Actions ausführen
            for action in actions:
                try:
                    run_action(page, action)
                except Exception as e:
                    res.warnings.append(f"Action '{action.get('type')}' fehlgeschlagen: {e}")

            # Secret-Guard — Screenshot blockieren wenn Secret im DOM
            dom_text = ""
            try:
                dom_text = str(page.evaluate("document.body?.innerText ?? ''", timeout=3000))
            except Exception:
                pass

            guard = scan_text(dom_text)
            if not guard.safe:
                labels = ", ".join(f.label for f in guard.findings)
                print(f"  ⛔  BLOCKIERT — Secrets im DOM: {labels}")
                res.warnings.append(f"Screenshot blockiert: {labels}")
                continue

            # Screenshot
            raw_path = OUTPUT_DIR / f"{filename}.png"
            try:
                page.screenshot(path=str(raw_path), timeout=15000)
                res.screenshot_ok = True
                kb = raw_path.stat().st_size // 1024
                print(f"  ✓  {filename}.png ({kb} KB)")
            except Exception as e:
                print(f"  ✗  Screenshot fehlgeschlagen: {e}")
                res.warnings.append(f"Screenshot-Fehler: {e}")
                continue

            # Marker per DOM suchen
            markers_placed: list[tuple[int, int, str]] = []

            for m in markers:
                find_text = m.get("find_text", "")
                fallback  = m.get("fallback")
                anchor    = m.get("anchor", "center")
                label     = m.get("label", "●")

                el = find_element(page, find_text, fallback)

                if el:
                    cx = int(el["x"])
                    cy = int(el["y"])
                    cx, cy = apply_anchor(cx, cy, int(el.get("w", 0)), int(el.get("h", 0)), anchor)
                    markers_placed.append((cx, cy, label))
                    res.markers_found += 1
                    print(f"    ✓  [{label}] → ({cx},{cy})  [{el.get('text','?')[:40]}]")
                else:
                    searched = f"'{find_text}'" + (f" / '{fallback}'" if fallback else "")
                    print(f"    ⚠  MARKER NICHT GESETZT [{label}]")
                    print(f"       Kein sichtbares Element für: {searched}")
                    print(f"       → find_text in stories.yaml anpassen")
                    res.missing_markers.append(label)

            # Annotation — nur wenn ALLE Marker gefunden
            if res.missing_markers:
                print(f"  ⚠  Annotierte Version nicht erzeugt ({len(res.missing_markers)} Marker fehlen)")
                print(f"     Fehlende Marker: {res.missing_markers}")
            elif markers_placed:
                dst = annotate_image(raw_path, markers_placed)
                res.annotated_ok = True
                kb = dst.stat().st_size // 1024
                print(f"  ✓  {dst.name} ({kb} KB)")
            else:
                print(f"  ℹ  Keine Marker definiert — nur raw Screenshot")
                res.annotated_ok = True  # raw ist OK für marker-lose sections

        browser.close()

    # ── End-Report ─────────────────────────────────────────────────────────────
    print("\n" + "═"*60)
    print("REPORT")
    print("═"*60)
    total_shots = sum(1 for r in results if r.screenshot_ok)
    total_ann   = sum(1 for r in results if r.annotated_ok)
    total_mf    = sum(r.markers_found for r in results)
    total_mt    = sum(r.markers_total for r in results)

    for r in results:
        shot_icon = "✓" if r.screenshot_ok else "✗"
        ann_icon  = "✓" if r.annotated_ok else "⚠"
        print(f"  [{shot_icon} screenshot][{ann_icon} annotiert] {r.id}")
        print(f"    Marker: {r.markers_found}/{r.markers_total} gefunden", end="")
        if r.missing_markers:
            print(f"  ← FEHLEN: {r.missing_markers}", end="")
        print()
        for w in r.warnings:
            print(f"    ⚠  {w}")

    print(f"\nGesamt: {total_shots}/{len(results)} Screenshots  |  {total_ann}/{len(results)} annotiert  |  Marker: {total_mf}/{total_mt}")
    if total_mf < total_mt:
        print("\n⚠  Fehlende Marker = find_text in stories.yaml stimmt nicht mit UI-Text überein.")
        print("   Tipp: DOM-Text per page.evaluate(\"document.body.innerText\") prüfen.")
    print(f"\nOutput: {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
