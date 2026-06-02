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
class MarkerResult:
    label:     str
    found:     bool
    element:   str = ""    # tag:text[:40]
    bbox:      str = ""    # "x,y w×h"
    warning:   str = ""

@dataclass
class SectionResult:
    id:            str
    expected_view: str = ""
    ready_check:   bool | None = None   # None = no ready_text defined
    screenshot_ok: bool = False
    annotated_ok:  bool = False
    markers:       list[MarkerResult] = field(default_factory=list)
    warnings:      list[str] = field(default_factory=list)

    @property
    def markers_found(self) -> int:
        return sum(1 for m in self.markers if m.found)

    @property
    def markers_total(self) -> int:
        return len(self.markers)

    @property
    def missing_markers(self) -> list[str]:
        return [m.label for m in self.markers if not m.found]

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

# ── Ready-Check ───────────────────────────────────────────────────────────────

def wait_for_ready(page: Page, ready_text: str, timeout_ms: int = 8000) -> bool:
    """
    Wartet bis ready_text im sichtbaren DOM erscheint.
    Gibt True zurück wenn bereit, False bei Timeout.
    """
    try:
        page.wait_for_function(
            f"document.body.innerText.includes({json.dumps(ready_text)})",
            timeout=timeout_ms,
        )
        return True
    except Exception:
        return False

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

    # Save into annotated/ subdir with _annotated.png naming — this is
    # exactly where the API gallery reads from (/api/admin/screenshots/).
    annotated_dir = src.parent / "annotated"
    annotated_dir.mkdir(parents=True, exist_ok=True)
    dst = annotated_dir / src.name.replace(".png", "_annotated.png")
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
            sid        = section.get("id", "unknown")
            filename   = section.get("filename", sid)
            title      = section.get("title", sid)
            tab        = section.get("tab", "dashboard")
            scroll_y   = section.get("scroll_y", 0)
            actions    = section.get("actions", [])
            m_defs     = section.get("markers", [])
            ready_text = section.get("ready_text", "")

            res = SectionResult(id=sid, expected_view=tab)
            results.append(res)
            print(f"── [{sid}] {title}")
            print(f"   View: {tab}  |  Ready: {ready_text!r}")

            # 1. Tab navigieren
            ok = navigate_tab(page, tab)
            if not ok:
                try:
                    btns = page.evaluate(
                        "Array.from(document.querySelectorAll('button')).map(b=>b.innerText.trim()).filter(t=>t).slice(0,6)"
                    )
                    print(f"   ⚠  Tab '{tab}' nicht gefunden. Buttons: {btns}")
                except Exception:
                    print(f"   ⚠  Tab '{tab}' nicht gefunden")
                res.warnings.append(f"Tab '{tab}' nicht gefunden")

            if scroll_y:
                page.evaluate(f"window.scrollTo(0, {scroll_y})")
                page.wait_for_timeout(300)

            # 2. Actions
            for action in actions:
                try:
                    run_action(page, action)
                except Exception as e:
                    res.warnings.append(f"Action {action.get('type')} failed: {e}")

            # 3. Ready-Check — bestätigt korrekten View-Zustand
            if ready_text:
                ready = wait_for_ready(page, ready_text, timeout_ms=8000)
                res.ready_check = ready
                if ready:
                    print(f"   ✓  Ready: '{ready_text}' sichtbar")
                else:
                    sample = ""
                    try:
                        sample = str(page.evaluate("document.body.innerText"))[:80].replace("\n"," ")
                    except Exception:
                        pass
                    print(f"   ⚠  NOT READY: '{ready_text}' nicht sichtbar nach 8s")
                    print(f"      DOM-Sample: {sample!r}")
                    res.warnings.append(f"Ready-Check fehlgeschlagen: '{ready_text}'")

            # 4. Secret-Guard
            dom_text = ""
            try:
                dom_text = str(page.evaluate("document.body?.innerText ?? ''"))
            except Exception:
                pass
            guard = scan_text(dom_text)
            if not guard.safe:
                labels = ", ".join(f.label for f in guard.findings)
                print(f"   ⛔  BLOCKIERT — Secrets erkannt: {labels}")
                res.warnings.append(f"Blockiert: {labels}")
                continue

            # 5. Screenshot
            raw_path = OUTPUT_DIR / f"{filename}.png"
            try:
                page.screenshot(path=str(raw_path), timeout=15000)
                res.screenshot_ok = True
                kb = raw_path.stat().st_size // 1024
                print(f"   ✓  {filename}.png ({kb} KB)")
            except Exception as e:
                print(f"   ✗  Screenshot fehlgeschlagen: {e}")
                res.warnings.append(f"Screenshot: {e}")
                continue

            # 6. Marker
            markers_placed: list[tuple[int, int, str]] = []

            for m in m_defs:
                find_text = m.get("find_text", "")
                fallback  = m.get("fallback")
                anchor    = m.get("anchor", "center")
                label     = m.get("label", "●")

                el = find_element(page, find_text, fallback)

                if el:
                    cx = int(el["x"])
                    cy = int(el["y"])
                    cx, cy = apply_anchor(cx, cy, int(el.get("w", 0)), int(el.get("h", 0)), anchor)
                    cx = max(20, min(VIEWPORT["width"]  - 20, cx))
                    cy = max(20, min(VIEWPORT["height"] - 20, cy))
                    markers_placed.append((cx, cy, label))
                    bbox_s = f"{int(el.get('x',0))},{int(el.get('y',0))} {int(el.get('w',0))}×{int(el.get('h',0))}"
                    elem_s = f"{el.get('tag','?')}:{el.get('text','?')[:30]}"
                    print(f"   ✓  [{label}]  {elem_s}  bbox={bbox_s}")
                    res.markers.append(MarkerResult(
                        label=label, found=True, element=elem_s, bbox=bbox_s
                    ))
                else:
                    searched = f"'{find_text}'" + (f" / '{fallback}'" if fallback else "")
                    print(f"   ⚠  MARKER FEHLT [{label}]  suche={searched}")
                    res.markers.append(MarkerResult(
                        label=label, found=False,
                        warning=f"kein sichtbares Element für {searched}"
                    ))

            # 7. Annotation
            if res.missing_markers:
                print(f"   ⚠  Keine Annotation — {len(res.missing_markers)} Marker fehlen: {res.missing_markers}")
            elif markers_placed:
                dst = annotate_image(raw_path, markers_placed)
                res.annotated_ok = True
                kb = dst.stat().st_size // 1024
                print(f"   ✓  {dst.name} ({kb} KB)")
            else:
                res.annotated_ok = True   # marker-lose section ist OK

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
        shot_sym  = "✓" if r.screenshot_ok else "✗"
        ann_sym   = "✓" if r.annotated_ok  else "⚠"
        ready_sym = ("✓" if r.ready_check else "⚠") if r.ready_check is not None else "—"
        print(f"\n  {shot_sym}screenshot  {ann_sym}annotiert  {ready_sym}ready  [{r.id}]")
        print(f"    View: {r.expected_view}")
        for mr in r.markers:
            sym = "✓" if mr.found else "⚠"
            detail = f"{mr.element}  bbox={mr.bbox}" if mr.found else mr.warning
            print(f"    {sym} [{mr.label}]  {detail}")
        for w in r.warnings:
            print(f"    ⚠  {w}")

    print(f"\n{'═'*60}")
    print(f"Gesamt:  {total_shots}/{len(results)} Screenshots  |  {total_ann}/{len(results)} annotiert  |  Marker: {total_mf}/{total_mt}")
    if total_mf < total_mt:
        print("⚠  Fehlende Marker → find_text in stories.yaml präzisieren")
    print(f"Output:  {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
