"""
VoteBroker Showcase – echte Screenshots mit gespeicherter Session
"""

import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

SESSION_TOKEN = "xWO03-kHmwyTvywV32kZhDusDWtokbkcp8gcpYWHJkaECSRW"
BASE_URL      = "https://votebroker.org"
OUTPUT_DIR    = Path("/opt/votebroker-modern/tools/showcase/raw")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

VIEWPORT = {"width": 1280, "height": 900}

def wait(page, ms=1500):
    page.wait_for_timeout(ms)

def shot(page, name):
    out = OUTPUT_DIR / f"{name}.png"
    page.screenshot(path=str(out), full_page=False)
    print(f"  ✓  {name}.png")
    return out

def click_tab(page, tab_name):
    """Klickt auf einen Tab per Text-Inhalt."""
    page.evaluate(f"""
        document.querySelectorAll('button, [role=tab], nav a, li').forEach(el => {{
            if (el.innerText && el.innerText.trim().toLowerCase().includes('{tab_name.lower()}')) {{
                el.click();
            }}
        }});
    """)
    wait(page, 1800)

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    ctx = browser.new_context(
        viewport=VIEWPORT,
        locale="de-DE",
    )

    page = ctx.new_page()
    page.set_extra_http_headers({"session": SESSION_TOKEN})

    # AuthSession-Objekt wie die React-App es erwartet
    session_json = (
        f'{{"token":"{SESSION_TOKEN}",'
        f'"expiry":"2026-06-03T15:30:34.787Z",'
        f'"user":{{"username":"jan-philippvieth","provider":"steemconnect"}}}}'
    )

    print("Öffne VoteBroker und injiziere Session…")
    # Erst laden, dann Session setzen, dann neuladen
    page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)
    page.evaluate(f"localStorage.setItem('votebroker.session', {repr(session_json)})")
    page.reload(wait_until="networkidle", timeout=30000)
    wait(page, 3000)

    print("Screenshots:")

    # ── 1. Dashboard (Startansicht) ────────────────────────────────────────────
    shot(page, "05_dashboard_overview")

    # ── 2. DNA-Tab ────────────────────────────────────────────────────────────
    click_tab(page, "dna")
    shot(page, "01_dna_opportunities")

    # ── 3. Vote-Plan (zurück auf Dashboard oder eigener Bereich) ──────────────
    click_tab(page, "dashboard")
    wait(page, 1000)
    shot(page, "02_vote_plan")

    # Scroll zu Vote-Plan-Bereich falls vorhanden
    page.evaluate("window.scrollBy(0, 400)")
    wait(page, 600)
    shot(page, "03_vote_weights")

    # Scroll weiter zu Bestätigungsbereich
    page.evaluate("window.scrollBy(0, 400)")
    wait(page, 600)
    shot(page, "04_vote_send")

    # Scroll zurück nach oben
    page.evaluate("window.scrollTo(0, 0)")
    wait(page, 500)

    # ── 4. Community-Tab ──────────────────────────────────────────────────────
    click_tab(page, "community")
    shot(page, "06_community_discovery")

    browser.close()

print(f"\nRaw screenshots → {OUTPUT_DIR}")
