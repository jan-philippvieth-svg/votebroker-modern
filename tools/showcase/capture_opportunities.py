"""
VoteBroker Screenshot – Opportunities Tab mit ausgeklapptem Score-Detail
"""

from pathlib import Path
from playwright.sync_api import sync_playwright

SESSION_TOKEN = "X-yz_FdD7s8u6OBDhX-u4btJTh1xIF_TWJv-XX0PZxqbGnMS"
SESSION_EXPIRY = "2026-06-20T00:56:14.157Z"
BASE_URL   = "https://votebroker.org"
OUTPUT_DIR = Path("/opt/votebroker-modern/tools/showcase/raw")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

VIEWPORT = {"width": 1280, "height": 900}

session_json = (
    f'{{"token":"{SESSION_TOKEN}",'
    f'"expiry":"{SESSION_EXPIRY}",'
    f'"user":{{"username":"jan-philippvieth","provider":"steemconnect"}}}}'
)


def wait(page, ms=1500):
    page.wait_for_timeout(ms)


def shot(page, name):
    out = OUTPUT_DIR / f"{name}.png"
    page.screenshot(path=str(out), full_page=False)
    print(f"  ✓  {name}.png")
    return out


with sync_playwright() as pw:
    browser = pw.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    ctx = browser.new_context(viewport=VIEWPORT, locale="de-DE")

    # Inject session before any page script runs
    ctx.add_init_script(f"localStorage.setItem('votebroker.session', {repr(session_json)})")

    page = ctx.new_page()

    print("App laden…")
    page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
    wait(page, 1000)

    # Landing page is always shown first — click "Dashboard öffnen" to enter the app
    print("Dashboard öffnen…")
    page.get_by_text("Dashboard öffnen").first.click()
    wait(page, 5000)  # Wait for all API calls + render

    # ── Opportunities-Tab öffnen ──────────────────────────────────────────────
    print("Opportunities-Tab…")
    opp_btn = page.get_by_text("Opportunities").first
    opp_btn.click()
    wait(page, 6000)  # Wait for API response + render

    shot(page, "07_opportunities_list")

    # ── Score-Detail des ersten Posts aufklappen ──────────────────────────────
    print("Score aufklappen…")
    expanded = page.evaluate("""
        () => {
            const spans = document.querySelectorAll('td span');
            for (const s of spans) {
                if (s.textContent && s.textContent.includes('▼')) {
                    s.click();
                    return true;
                }
            }
            const firstRow = document.querySelector('tbody tr');
            if (firstRow) { firstRow.click(); return 'fallback'; }
            return false;
        }
    """)
    print(f"  expanded: {expanded}")
    wait(page, 1000)

    shot(page, "08_opportunities_score")

    browser.close()

print(f"\nRaw screenshots → {OUTPUT_DIR}")
