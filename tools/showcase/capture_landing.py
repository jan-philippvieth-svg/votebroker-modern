"""
VoteBroker Landing-Page Screenshot Capture
============================================
Erzeugt saubere, markerfreie App-Screenshots für die Landingpage.

Vorgehen pro Tab:
  1. /dashboard öffnen, warten auf [data-testid="app-ready"]
  2. Klick auf [data-testid="tab-<id>"]
  3. Tab-spezifisch warten + scrollen
  4. Screenshot

Dashboard-Sonderfall:
  Scrollt zu [data-testid="dashboard-kpi-section"] (Curation Timeline,
  Voting Power, VP-Chart) statt zur oberen Header-Fläche.

Usage:
  SESSION_TOKEN=<t> PROMO_LOCALE=de   python3 capture_landing.py
  SESSION_TOKEN=<t>                   python3 capture_landing.py  # alle Locales

Env-Variablen:
  SESSION_TOKEN                 required
  PROMO_LOCALE                  optional — einzelne Sprache
  NGINX_URL                     default: http://172.19.0.4
  VOTEBROKER_SCREENSHOTS_DIR    default: /var/lib/docker/volumes/…/public-screenshots
"""

import os, json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# ── Config ────────────────────────────────────────────────────────────────────

NGINX  = os.environ.get("NGINX_URL", "http://172.19.0.4")
TOKEN  = os.environ.get("SESSION_TOKEN", "")
PUBDIR = Path(os.environ.get(
    "VOTEBROKER_SCREENSHOTS_DIR",
    "/var/lib/docker/volumes/votebroker_data/_data/public-screenshots"
))

if not TOKEN:
    print("ERROR: SESSION_TOKEN required"); sys.exit(1)

_env_locale = os.environ.get("PROMO_LOCALE", "")
LOCALES = [_env_locale] if _env_locale else ["de", "en"]

SESSION_OBJ = {
    "token":  TOKEN,
    "expiry": "2099-01-01T00:00:00.000Z",
    "user":   {"username": "jan-philippvieth", "provider": "steemconnect"},
}

# ── Tab definitions ───────────────────────────────────────────────────────────
# (tab_id, output_stem)
# All navigation and waiting is handled per-tab in capture_tab().
TABS = [
    ("dashboard",  "dashboard"),
    ("dna",        "vote-dna"),
    ("community",  "community"),
    ("billing",    "settings"),    # Consent & Einstellungen
]

# ── Helpers ───────────────────────────────────────────────────────────────────

def wait_sel(page, selector, timeout=10000) -> bool:
    try:
        page.wait_for_selector(selector, state="visible", timeout=timeout)
        return True
    except PWTimeout:
        print(f"    ⚠ timeout: {selector}")
        return False


def wait_text(page, text, timeout=10000):
    try:
        page.wait_for_function(
            f"document.body.innerText.includes({json.dumps(text)})",
            timeout=timeout
        )
    except PWTimeout:
        pass


def capture_tab(page, tab_id: str) -> None:
    """Navigate to tab and prepare viewport for screenshot."""

    tab_sel = f'[data-testid="tab-{tab_id}"]'
    if not wait_sel(page, tab_sel, timeout=5000):
        raise RuntimeError(f"Tab selector not found: {tab_sel}")

    page.click(tab_sel)
    page.wait_for_timeout(2500)

    if tab_id == "dashboard":
        # Scroll to OperativeKPIRow: Voting Power | Heute | 7 Tage | Lifetime | VP-Chart
        # data-testid="dashboard-marketing-section" is on the OperativeKPIRow wrapper.
        mkt_sel = '[data-testid="dashboard-marketing-section"]'
        if wait_sel(page, mkt_sel, timeout=8000):
            page.evaluate(
                "document.querySelector('[data-testid=\"dashboard-marketing-section\"]')"
                ".scrollIntoView({ behavior: 'instant', block: 'start' })"
            )
            page.wait_for_timeout(800)
        else:
            # Fallback: scroll past the DNA profile header
            page.evaluate("window.scrollTo(0, 260)")
            page.wait_for_timeout(500)

    elif tab_id == "dna":
        # Wait for Vote-DNA content
        wait_text(page, "Vote-DNA", timeout=8000)
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(500)

    elif tab_id == "community":
        # Wait for Community-specific content (Whale Discovery / Author Radar)
        wait_text(page, "Signal", timeout=10000)
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(500)

    elif tab_id == "billing":
        # Wait for consent/settings content, then scroll to Berechtigungen section
        wait_text(page, "Berechtigungen", timeout=8000)
        page.evaluate("""
            const el = Array.from(document.querySelectorAll('*'))
                .find(e => e.children.length < 4 &&
                           e.textContent.trim().startsWith('Berechtigungen'));
            if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
        """)
        page.evaluate("window.scrollBy(0, -20)")  # small breathing room above header
        page.wait_for_timeout(600)

    page.wait_for_timeout(400)


# ── Main ──────────────────────────────────────────────────────────────────────

def capture_locale(browser, locale: str) -> list[str]:
    print(f"\n=== Locale: {locale} ===")
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    captured = []

    try:
        # 1. Inject session + locale
        page.goto(NGINX, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_timeout(400)
        page.evaluate(
            f"localStorage.setItem('votebroker.session', JSON.stringify({json.dumps(SESSION_OBJ)}))"
        )
        page.evaluate(
            f"localStorage.setItem('votebroker.locale', {json.dumps(locale)})"
        )

        # 2. Load app — wait for auth-confirmed marker
        page.goto(f"{NGINX}/dashboard", wait_until="domcontentloaded", timeout=25000)
        if not wait_sel(page, '[data-testid="app-ready"]', timeout=12000):
            print("  ✗ app-ready not found — session invalid or app not loaded")
            return []
        page.wait_for_timeout(1500)
        print(f"  ✓ app-ready")

        # 3. Capture each tab
        for tab_id, fname in TABS:
            print(f"  Tab: {tab_id}")
            try:
                capture_tab(page, tab_id)
            except RuntimeError as e:
                print(f"  ✗ {e} — skipping")
                continue

            out = PUBDIR / f"{fname}-{locale}.png"
            page.screenshot(path=str(out), full_page=False)
            kb = out.stat().st_size // 1024
            print(f"  ✓ {out.name}  {kb} KB")
            captured.append(str(out))

    finally:
        ctx.close()

    return captured


def main():
    PUBDIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        all_captured = []
        for locale in LOCALES:
            all_captured.extend(capture_locale(browser, locale))
        browser.close()

    print(f"\n✓ Done — {len(all_captured)} screenshots in {PUBDIR}")
    for f in all_captured:
        print(f"  {Path(f).name}")


if __name__ == "__main__":
    main()
