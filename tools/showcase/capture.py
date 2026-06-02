"""
VoteBroker Showcase — Screenshot Capture
==========================================
Nimmt authentifizierte Screenshots der 6 Showcase-Schritte auf.

Usage:
  SESSION_TOKEN=<token> python3 capture.py [output_dir]
  python3 capture.py <session_token> [output_dir]

Kein Secret in dieser Datei gespeichert.

Output (Standard):
  tools/showcase/output/raw/
    01_dashboard.png
    02_find_votes.png
    03_vote_plan.png
    04_edit_weights.png
    05_confirm_votes.png
    06_community.png
"""

import sys, os, json
from pathlib import Path
from playwright.sync_api import sync_playwright, Page
from secret_guard import scan_text, GuardResult

# ── Konfiguration — kein Secret im Code ───────────────────────────────────────

TOKEN = os.environ.get("SESSION_TOKEN") or (sys.argv[1] if len(sys.argv) > 1 else "")
if not TOKEN:
    print("ERROR: SESSION_TOKEN fehlt.")
    print("  export SESSION_TOKEN=<token>  oder  python3 capture.py <token>")
    sys.exit(1)

# SCREENSHOT_DEST: if set, raw screenshots go there (e.g. Docker volume path)
# Default: tools/showcase/output/raw (host-local)
_dest_env = os.environ.get("SCREENSHOT_DEST", "")
OUTPUT_DIR = Path(
    sys.argv[2] if len(sys.argv) > 2
    else (_dest_env if _dest_env else str(Path(__file__).parent / "output" / "raw"))
)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# nginx-Container (neueste dist, SPA-routing, kein Caddy-Cache)
# API-Container direkt (HTTP, kein Protokoll-Mismatch bei Playwright-Routing)
NGINX_URL = "http://172.19.0.3"
API_URL   = "http://172.19.0.2:3000"

VIEWPORT = {"width": 1600, "height": 1000}

SESSION_OBJ = {
    "token":  TOKEN,
    "expiry": "2026-12-31T23:59:59.000Z",
    "user":   {"username": "jan-philippvieth", "provider": "steemconnect"},
}

# ── Hilfsfunktionen ────────────────────────────────────────────────────────────

def _dom_secret_check(page: Page, name: str) -> GuardResult:
    """Extract visible DOM text and scan for secrets before taking screenshot."""
    try:
        text = page.evaluate("document.body?.innerText ?? ''")
        return scan_text(str(text))
    except Exception:
        return GuardResult(safe=True, findings=[])

def shot(page: Page, name: str) -> Path | None:
    """Takes screenshot after Secret-Guard DOM scan. Returns None if blocked."""
    guard = _dom_secret_check(page, name)
    if not guard.safe:
        labels = ", ".join(f.label for f in guard.findings)
        print(f"  ⛔  {name}.png BLOCKIERT — mögliche Secrets erkannt: {labels}")
        print(f"      Datei NICHT gespeichert.")
        return None

    out = OUTPUT_DIR / f"{name}.png"
    page.screenshot(path=str(out), full_page=False)
    kb = out.stat().st_size // 1024
    print(f"  ✓  {name}.png  ({kb} KB)")
    return out

def wait(page: Page, ms: int = 1500):
    page.wait_for_timeout(ms)

def scroll_to(page: Page, y: int):
    page.evaluate(f"window.scrollTo(0, {y})")
    wait(page, 400)

def click_tab(page: Page, text: str):
    """Klickt den Tab-Button der den Text exakt oder teilweise enthält."""
    page.evaluate(f"""
        const kw = {json.dumps(text.lower())};
        Array.from(document.querySelectorAll('nav button, [role=tab], button'))
          .find(b => b.innerText.trim().toLowerCase() === kw
                  || b.innerText.trim().toLowerCase().startsWith(kw))
          ?.click();
    """)
    wait(page, 400)

def click_button(page: Page, text: str):
    """Klickt den ersten Button der den Text enthält."""
    page.evaluate(f"""
        const kw = {json.dumps(text.lower())};
        Array.from(document.querySelectorAll('button'))
          .find(b => b.innerText.trim().toLowerCase().includes(kw))
          ?.click();
    """)

def wait_for_content(page: Page, text: str, timeout_ms: int = 8000):
    """Wartet bis Text im DOM erscheint (bestätigt Daten-Load)."""
    try:
        page.wait_for_function(
            f"document.body.innerText.includes({json.dumps(text)})",
            timeout=timeout_ms,
        )
    except Exception:
        pass  # Timeout okay — Screenshot trotzdem

# ── Haupt-Capture ──────────────────────────────────────────────────────────────

print(f"Output:   {OUTPUT_DIR}")
print(f"Viewport: {VIEWPORT['width']}×{VIEWPORT['height']}")
print()

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    ctx = browser.new_context(
        viewport=VIEWPORT,
        locale="de-DE",
        timezone_id="Europe/Berlin",
    )

    # API-Calls des React-SPA zum API-Container weiterleiten
    def proxy_api(route):
        original = route.request.url
        new_url = original.replace(NGINX_URL, API_URL)
        hdrs = dict(route.request.headers)
        hdrs["session"] = TOKEN
        try:
            route.continue_(url=new_url, headers=hdrs)
        except Exception:
            route.continue_()

    page = ctx.new_page()
    page.route(f"{NGINX_URL}/api/**", proxy_api)

    # ── 1. Session injizieren & zum Dashboard navigieren ─────────────────────
    print("Starte App…")
    page.goto(NGINX_URL, wait_until="domcontentloaded", timeout=30000)
    wait(page, 500)
    page.evaluate(f"localStorage.setItem('votebroker.session', JSON.stringify({json.dumps(SESSION_OBJ)}))")
    page.goto(f"{NGINX_URL}/dashboard", wait_until="domcontentloaded", timeout=30000)

    # Warte bis Benutzerdaten geladen (Username in Header sichtbar)
    wait_for_content(page, "jan-philippvieth", timeout_ms=10000)
    wait(page, 2000)

    print("Screenshots:")

    # ── 01: Dashboard — Übersicht mit allen Metriken ─────────────────────────
    click_tab(page, "dashboard")
    wait_for_content(page, "UNTERSTÜTZTE AUTOREN", timeout_ms=5000)
    scroll_to(page, 0)
    wait(page, 800)
    shot(page, "01_dashboard")

    # ── 02: Vote-DNA — Chancen finden (Offene Posts suchen) ──────────────────
    click_tab(page, "vote-dna")
    wait(page, 1000)
    scroll_to(page, 0)
    # Klicke "Offene Posts suchen" und warte auf Ergebnisse
    click_button(page, "offene posts suchen")
    wait(page, 3000)   # Lade-Zeit für Post-Scan
    shot(page, "02_find_votes")

    # ── 03: Vote-Plan generieren ──────────────────────────────────────────────
    scroll_to(page, 0)
    click_button(page, "vote-plan generieren")
    wait(page, 3000)
    wait_for_content(page, "VP NACH PLAN", timeout_ms=6000)
    scroll_to(page, 0)
    shot(page, "03_vote_plan")

    # ── 04: Plan-Details — Gewichte & einzelne Einträge ──────────────────────
    scroll_to(page, 350)
    wait(page, 500)
    shot(page, "04_edit_weights")

    # ── 05: Votes absenden — Bestätigung ─────────────────────────────────────
    scroll_to(page, 0)
    # Bestätigungs-Bereich ist weiter unten im Plan
    wait_for_content(page, "Vote", timeout_ms=3000)
    scroll_to(page, 700)
    shot(page, "05_confirm_votes")

    # ── 06: Community — Entdecken ─────────────────────────────────────────────
    click_tab(page, "community")
    wait(page, 3000)   # Community lädt lazy
    scroll_to(page, 0)
    shot(page, "06_community")

    browser.close()

print(f"\nFertig: {OUTPUT_DIR}")
