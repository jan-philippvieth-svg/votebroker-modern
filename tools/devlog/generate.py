"""
VoteBroker Devlog Generator
============================
Liest Git-Commits seit dem letzten Devlog, kategorisiert sie und
erzeugt einen strukturierten Draft im VoteBroker-Content-System.

Usage:
  python3 generate.py [--screenshots] [--date YYYY-MM-DD] [--force]

Optionen:
  --screenshots    Erstellt zusätzlich annotierte Screenshots
  --date           Datum für den Draft (Standard: heute)
  --force          Überschreibt existierenden Draft für dieses Datum
  --since          "seit"-Datum für git log (Standard: letzter Devlog-Datum)
  --next ITEM      Roadmap-Item hinzufügen (wiederholbar)
  --dry-run        Nur ausgeben, nicht speichern

Kein Session-Token nötig (nur API-Zugriff auf localhost).
"""

import argparse, json, re, subprocess, sys, os
from datetime import date, datetime, timezone
from pathlib import Path
from urllib import request as urllib_request

REPO_ROOT  = Path(__file__).parent.parent.parent  # votebroker-modern/
API_BASE        = "http://172.19.0.2:3000"         # API-Container direkt
OPERATOR_TOKEN  = os.environ.get("OPERATOR_TOKEN", "79143190008aec5ee956e8afa5f350ea56dc6272c95c03fdc180bf5955edebc8")
SCRIPT_DIR = Path(__file__).parent.parent / "showcase"

# ── Commit-Kategorisierung ────────────────────────────────────────────────────

# Mapping von Commit-Präfix-Pattern → DevlogChange.type
CATEGORY_PATTERNS = [
    (re.compile(r"^feat\(ux\)|^fix\(ux\)|ux[:\s]", re.I),           "ux"),
    (re.compile(r"^feat[:\(]"),                                        "feat"),
    (re.compile(r"^fix[:\(]"),                                         "fix"),
    (re.compile(r"^perf[:\(]"),                                        "perf"),
    (re.compile(r"^refactor[:\(]"),                                    "refactor"),
]

# Commits die nichts Nutzer-relevantes sagen → überspringen
SKIP_PATTERNS = re.compile(
    r"^(chore|ci|test|docs|style|bump|merge|wip|revert|tmp)\b", re.I
)

_CONV_PREFIX = re.compile(
    r"^(feat|fix|perf|refactor|style|docs|chore|ux|ci|test|build)"
    r"(\([^)]*\))?!?:\s*",
    re.I,
)

def _strip_prefix(subject: str) -> str:
    """Remove conventional commit prefix: feat(scope): → clean description."""
    cleaned = _CONV_PREFIX.sub("", subject).strip()
    return cleaned[0].upper() + cleaned[1:] if cleaned else subject

def categorize(subject: str) -> tuple[str, str] | None:
    """Returns (type, cleaned_description) or None to skip."""
    if SKIP_PATTERNS.match(subject): return None
    for pat, cat in CATEGORY_PATTERNS:
        if pat.search(subject):
            return cat, _strip_prefix(subject)
    # No conventional prefix — include as "other" if it looks meaningful
    if len(subject.split()) >= 3:
        return "other", subject
    return None

def get_commits(since: str, repo: Path) -> list[dict]:
    """Returns list of {hash, subject, body} dicts since the given ISO date."""
    cmd = [
        "git", "-C", str(repo), "log",
        f"--since={since}",
        "--no-merges",
        "--pretty=format:%H\x1f%s\x1f%b\x1e",
    ]
    out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)
    commits = []
    for block in out.strip().split("\x1e"):
        block = block.strip()
        if not block: continue
        parts = block.split("\x1f", 2)
        commits.append({
            "hash":    parts[0].strip() if len(parts) > 0 else "",
            "subject": parts[1].strip() if len(parts) > 1 else "",
            "body":    parts[2].strip() if len(parts) > 2 else "",
        })
    return commits

def build_changes(commits: list[dict]) -> list[dict]:
    """Convert commits to structured change objects, deduplicated."""
    seen = set()
    changes = []
    for c in commits:
        result = categorize(c["subject"])
        if not result: continue
        cat, desc = result
        key = desc.lower()[:80]
        if key in seen: continue
        seen.add(key)
        changes.append({"type": cat, "description": desc})
    return changes

# ── API-Aufruf ────────────────────────────────────────────────────────────────

def get_last_devlog_date() -> str | None:
    """Query API for last devlog date (to know 'since when' for git log)."""
    try:
        req = urllib_request.Request(f"{API_BASE}/api/admin/content")
        with urllib_request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        devlogs = [d for d in data.get("drafts", []) if d["type"] == "devlog-post"]
        if devlogs:
            return sorted(devlogs, key=lambda d: d["dateStr"])[-1]["dateStr"]
    except Exception:
        pass
    return None

def call_generate_api(payload: dict) -> dict:
    body = json.dumps(payload).encode()
    req  = urllib_request.Request(
        f"{API_BASE}/api/devlog/generate",
        data=body,
        headers={
            "Content-Type":    "application/json",
            "X-Operator-Token": OPERATOR_TOKEN,
        },
        method="POST",
    )
    with urllib_request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

# ── Screenshot-Integration ────────────────────────────────────────────────────

def take_screenshots(session_token: str) -> list[str]:
    """Run capture.py + annotate.py, return list of annotated filenames."""
    capture = SCRIPT_DIR / "capture.py"
    annotate = SCRIPT_DIR / "annotate.py"
    if not capture.exists() or not annotate.exists():
        print("  ⚠  Screenshot-Scripts nicht gefunden — übersprungen")
        return []

    print("  Nehme Screenshots auf…")
    env = {**os.environ, "SESSION_TOKEN": session_token}
    subprocess.run([sys.executable, str(capture)], env=env, check=True)

    print("  Annotiere Screenshots…")
    subprocess.run([sys.executable, str(annotate)], check=True)

    annotated_dir = SCRIPT_DIR / "output" / "annotated"
    files = sorted(annotated_dir.glob("*.png"))
    return [str(f) for f in files]

# ── Hauptprogramm ─────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="VoteBroker Devlog Generator")
    p.add_argument("--screenshots",    action="store_true", help="Screenshots aufnehmen und einbetten")
    p.add_argument("--date",           default=None,        help="Draft-Datum (YYYY-MM-DD), Standard: heute")
    p.add_argument("--since",          default=None,        help="Git-Log seit Datum (YYYY-MM-DD)")
    p.add_argument("--next",           action="append",     dest="next_items", metavar="ITEM", help="Roadmap-Item")
    p.add_argument("--force",          action="store_true", help="Existierenden Draft überschreiben")
    p.add_argument("--dry-run",        action="store_true", help="Nur ausgeben, nicht speichern")
    p.add_argument("--session-token",  default=None,        help="Session-Token für Screenshots (oder SESSION_TOKEN env)")
    args = p.parse_args()

    today_str = args.date or date.today().isoformat()
    print(f"Devlog für: {today_str}")

    # "seit" Datum bestimmen
    since_date = args.since
    if not since_date:
        since_date = get_last_devlog_date()
        if since_date:
            print(f"Letzter Devlog: {since_date} — git log seit diesem Datum")
        else:
            since_date = "2026-05-01"
            print(f"Kein vorheriger Devlog gefunden — git log seit {since_date}")

    # Git-Commits lesen
    print(f"Lese Commits seit {since_date}…")
    commits = get_commits(since_date, REPO_ROOT)
    changes = build_changes(commits)
    print(f"  {len(commits)} Commits → {len(changes)} relevante Änderungen")

    if changes:
        for c in changes[:5]:
            print(f"  [{c['type']:8}] {c['description'][:70]}")
        if len(changes) > 5:
            print(f"  … und {len(changes)-5} weitere")

    # Screenshots (optional)
    screenshots: list[str] = []
    if args.screenshots:
        token = args.session_token or os.environ.get("SESSION_TOKEN", "")
        if not token:
            print("  ⚠  Kein SESSION_TOKEN — Screenshots übersprungen")
            print("       Setze: --session-token <token>  oder  export SESSION_TOKEN=<token>")
        else:
            screenshots = take_screenshots(token)
            print(f"  {len(screenshots)} Screenshots eingebettet")

    # Payload
    payload: dict = {
        "date":      today_str,
        "changes":   changes,
        "sinceDate": since_date,
        "force":     args.force,
    }
    if args.next_items:  payload["nextItems"]   = args.next_items
    if screenshots:      payload["screenshots"] = screenshots

    if args.dry_run:
        print("\nDry-run — würde senden:")
        print(json.dumps(payload, indent=2, ensure_ascii=False)[:2000])
        return

    # API aufrufen
    print("\nErzeuge Draft…")
    result = call_generate_api(payload)
    print(f"Ergebnis: {result['status']} — {result['filename']}")
    if result.get("reason"):
        print(f"Hinweis: {result['reason']}")

if __name__ == "__main__":
    main()
