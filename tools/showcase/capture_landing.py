"""
VoteBroker Landing-Page Screenshot Capture
============================================
Erzeugt saubere, markerfreie App-Screenshots für die Landingpage.

Vorgehen pro Tab:
  1. /dashboard öffnen
  2. Warten auf [data-testid="app-ready"]  → App ist geladen und authentifiziert
  3. Klick auf [data-testid="tab-<id>"]    → Tab ist aktiv
  4. Warten auf [data-testid="tab-<id>"][aria-current] oder fallback text
  5. Screenshot

Locales: alle via LOCALES-Variable oder PROMO_LOCALE env.

Usage:
  SESSION_TOKEN=<t> PROMO_LOCALE=de python3 capture_landing.py
  SESSION_TOKEN=<t> python3 capture_landing.py   # captures all locales
"""

import os, json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# ── Config ────────────────────────────────────────────────────────────────────

NGINX   = os.environ.get("NGINX_URL", "http://172.19.0.4")
TOKEN   = os.environ.get("SESSION_TOKEN", "")
PUBDIR  = Path(os.environ.get("VOTEBROKER_SCREENSHOTS_DIR",
               "/var/lib/docker/volumes/votebroker_data/_data/public-screenshots"))

if not TOKEN:
    print("ERROR: SESSION_TOKEN required")
    sys.exit(1)

# Single locale from env, or capture all supported locales
_env_locale = os.environ.get("PROMO_LOCALE", "")
LOCALES = [_env_locale] if _env_locale else ["de", "en"]

SESSION_OBJ = {
    "token":  TOKEN,
    "expiry": "2099-01-01T00:00:00.000Z",
    "user":   {"username": "jan-philippvieth", "provider": "steemconnect"},
}

# Tab definitions: (testid, wait_selector_or_text, output_stem)
TABS = [
    ("dashboard",  "tab-dashboard",  "dashboard"),
    ("dna",        "tab-dna",        "vote-dna"),
    ("community",  "tab-community",  "community"),
]

# ── Helpers ───────────────────────────────────────────────────────────────────

def wait_selector(page, selector, timeout=12000):
    try:
        page.wait_for_selector(selector, state="visible", timeout=timeout)
        return True
    except PWTimeout:
        print(f"  ⚠ timeout waiting for: {selector}")
        return False


def capture_locale(browser, locale: str) -> list[str]:
    print(f"\n=== Locale: {locale} ===")
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    captured = []

    try:
        # Step 1: Load root, inject session + locale into localStorage
        page.goto(NGINX, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_timeout(400)
        page.evaluate(
            f"localStorage.setItem('votebroker.session', JSON.stringify({json.dumps(SESSION_OBJ)}))"
        )
        page.evaluate(
            f"localStorage.setItem('votebroker.locale', {json.dumps(locale)})"
        )

        # Step 2: Open the app and wait for auth-confirmed marker
        page.goto(f"{NGINX}/dashboard", wait_until="domcontentloaded", timeout=25000)
        if not wait_selector(page, '[data-testid="app-ready"]', timeout=12000):
            print("  ✗ app-ready not found — session may be invalid")
            return []
        page.wait_for_timeout(1500)

        # Step 3: Capture each tab
        for tab_id, tab_testid, fname in TABS:
            print(f"  Tab: {tab_id}")

            # Click via stable data-testid selector
            tab_sel = f'[data-testid="tab-{tab_id}"]'
            if not wait_selector(page, tab_sel, timeout=5000):
                print(f"  ✗ {tab_sel} not found — skipping")
                continue

            page.click(tab_sel)
            page.wait_for_timeout(2500)

            # Wait for tab-specific content to settle
            # Use the tab button being "active" as confirmation
            try:
                page.wait_for_function(
                    f"document.querySelector('[data-testid=\"tab-{tab_id}\"]') && "
                    f"document.querySelector('[data-testid=\"tab-{tab_id}\"]').style.color !== 'rgb(96, 112, 120)'",
                    timeout=6000
                )
            except PWTimeout:
                pass  # Continue anyway — tab may already be active

            page.wait_for_timeout(1000)
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(300)

            out = PUBDIR / f"{fname}-{locale}.png"
            page.screenshot(path=str(out), full_page=False)
            kb = out.stat().st_size // 1024
            print(f"  ✓ {out.name}  {kb} KB")
            captured.append(str(out))

    finally:
        ctx.close()

    return captured


# ── Main ──────────────────────────────────────────────────────────────────────

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


if __name__ == "__main__":
    main()
