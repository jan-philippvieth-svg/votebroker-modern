"""Debug: Monitors console, network and session state."""
import json
from playwright.sync_api import sync_playwright

SESSION_TOKEN = "xWO03-kHmwyTvywV32kZhDusDWtokbkcp8gcpYWHJkaECSRW"
BASE_URL = "https://votebroker.org"

session_obj = {
    "token": SESSION_TOKEN,
    "expiry": "2026-12-31T23:59:59.000Z",
    "user": {"username": "jan-philippvieth", "provider": "steemconnect"}
}

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()

    # Monitor API calls and console
    api_calls = []
    console_errors = []

    page.on("console", lambda msg: console_errors.append(f"{msg.type}: {msg.text}") if msg.type in ["error","warn"] else None)
    page.on("response", lambda r: api_calls.append(f"{r.status} {r.url}") if "/api/" in r.url else None)

    page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(1000)
    page.evaluate(f"localStorage.setItem('votebroker.session', JSON.stringify({json.dumps(session_obj)}))")
    page.reload(wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(6000)  # Warte auf alle API-Calls

    # Prüfe Session-Status nach allen API-Calls
    ls_after = page.evaluate("localStorage.getItem('votebroker.session')")
    print(f"Session nach API-Calls: {'VORHANDEN' if ls_after else '===GELÖSCHT==='}")

    print("\nAPI-Calls:")
    for c in api_calls[-15:]:
        print(f"  {c}")

    print("\nConsole-Errors:")
    for e in console_errors[:10]:
        print(f"  {e}")

    page.screenshot(path="/opt/votebroker-modern/tools/showcase/debug.png")
    browser.close()
