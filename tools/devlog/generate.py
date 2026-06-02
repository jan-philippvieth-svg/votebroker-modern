"""
VoteBroker Devlog Generator — mit Clustering, Deduplizierung und Priorisierung
================================================================================
Liest Git-Commits seit dem letzten Devlog, gruppiert sie in thematische Cluster,
entfernt Zwischenstände und wählt eine lesbare Auswahl für den Devlog.

Usage:
  python3 generate.py [options]

Optionen:
  --type [product|technical|micro]  Devlog-Typ (Standard: product)
  --screenshots                     Screenshots aufnehmen und einbetten
  --date YYYY-MM-DD                 Datum für den Draft (Standard: heute)
  --since YYYY-MM-DD                Commits seit diesem Datum
  --force                           Existierenden Draft überschreiben
  --next ITEM                       Roadmap-Item (wiederholbar)
  --dry-run                         Nur ausgeben, nicht speichern
  --session-token TOKEN             Session-Token für Screenshots

Kein Secret im Code gespeichert.
"""

import argparse, json, re, subprocess, sys, os
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from urllib import request as urllib_request
from urllib.error import HTTPError

REPO_ROOT      = Path(__file__).parent.parent.parent
SCRIPT_DIR     = Path(__file__).parent.parent / "showcase"
API_BASE       = "http://172.19.0.2:3000"
OPERATOR_TOKEN = os.environ.get("OPERATOR_TOKEN",
    "79143190008aec5ee956e8afa5f350ea56dc6272c95c03fdc180bf5955edebc8")

# ── Cluster-Definitionen ───────────────────────────────────────────────────────
# Format: name → (keywords, user_priority, visible_to_users)
# user_priority: 1 = höchste Relevanz für Nutzer, 5 = nur interne Infrastruktur

CLUSTERS: dict[str, tuple[list[str], int, bool]] = {
    "vote_planner": (
        ["vote plan", "planer", "planner", "cockpit", "strategie", "strategy",
         "gewicht", "weight.*%", "cta.*button", "duplicate.*button",
         "offene.*chancen", "opportunity", "vote.*confirm", "vote.*execute"],
        1, True,
    ),
    "pending_curation": (
        ["pending curation", "rshare", "curation.weight", "sbdpersteem",
         "sbdpersteem", "weight.based", "curation.estimate", "7.day",
         "post.limit", "80.post", "post.count"],
        1, True,
    ),
    "dashboard": (
        ["dashboard", "growth", "kpi", "chart", "vp.verlauf", "vp.graph",
         "analytics", "pending.*sp", "earned.*sp", "today.*stat"],
        2, True,
    ),
    "community": (
        ["community", "autor.radar", "discovery", "entdecken",
         "author.radar", "fake.*pool", "real.*pool"],
        2, True,
    ),
    "ux": (
        ["ux", "ui", "design", "light.mode", "anzeige", "label",
         "beschriftung", "rename.*usd", "sbdpersteem.*rename",
         "usd.*equivalent", "dollar.*weight"],
        2, True,
    ),
    "content_system": (
        ["devlog", "draft", "content.*system", "generate.*devlog",
         "screenshot.*pipeline", "admin.*cockpit", "generate.*button"],
        3, False,
    ),
    "bugfixes": (
        ["fix", "bug", "prevent.*voted", "race.condition", "reappear",
         "invalidat", "eacces", "permission", "already.voted"],
        1, True,
    ),
    "infrastructure": (
        ["deploy", "docker", "config", "volume", "env.*var",
         "scheduler", "cron", "db.*migration", "operator.token"],
        5, False,
    ),
}

CLUSTER_LABELS: dict[str, str] = {
    "vote_planner":     "Vote-Planer",
    "pending_curation": "Pending Curation",
    "dashboard":        "Dashboard & Analytics",
    "community":        "Community-Entdeckung",
    "ux":               "UI/UX-Verbesserungen",
    "content_system":   "Content-System",
    "bugfixes":         "Bugfixes",
    "infrastructure":   "Infrastruktur",
}

# ── Devlog-Typ-Konfiguration ───────────────────────────────────────────────────

DEVLOG_TYPES: dict[str, dict] = {
    "product": {
        "label":   "Product Update",
        "max_per_cluster": {
            "vote_planner": 2, "pending_curation": 2, "dashboard": 2,
            "community": 2, "ux": 2, "bugfixes": 2,
            "content_system": 0, "infrastructure": 0,
        },
        "max_total":   8,
        "only_visible": True,   # Nur nutzer-sichtbare Cluster
    },
    "technical": {
        "label":   "Technical Devlog",
        "max_per_cluster": {
            "vote_planner": 3, "pending_curation": 3, "dashboard": 2,
            "community": 2, "ux": 1, "bugfixes": 3,
            "content_system": 2, "infrastructure": 2,
        },
        "max_total":   14,
        "only_visible": False,
    },
    "micro": {
        "label":   "Micro Update",
        "max_per_cluster": {
            "vote_planner": 1, "pending_curation": 1, "dashboard": 1,
            "community": 1, "ux": 1, "bugfixes": 1,
            "content_system": 0, "infrastructure": 0,
        },
        "max_total":   5,
        "only_visible": True,
    },
}

# ── Commit-Filterung ───────────────────────────────────────────────────────────

SKIP_PATTERNS = re.compile(
    r"^(chore|ci|test|docs|style|bump|merge|wip|revert|tmp|typo)\b", re.I
)

_CONV_PREFIX = re.compile(
    r"^(feat|fix|perf|refactor|style|docs|chore|ux|ci|test|build)"
    r"(\([^)]*\))?!?:\s*", re.I,
)

def strip_prefix(subject: str) -> str:
    cleaned = _CONV_PREFIX.sub("", subject).strip()
    return cleaned[0].upper() + cleaned[1:] if cleaned else subject

def assign_cluster(subject: str) -> str | None:
    """Returns best-matching cluster name, or None to skip."""
    if SKIP_PATTERNS.match(subject):
        return None
    subj_lower = subject.lower()
    best_cluster, best_score = None, 0
    for cluster, (keywords, priority, _) in CLUSTERS.items():
        score = sum(1 for kw in keywords if re.search(kw, subj_lower))
        if score > best_score:
            best_score, best_cluster = score, cluster
    if best_cluster and best_score > 0:
        return best_cluster
    # Fallback: conventional prefix
    if re.match(r"^fix[:\(]", subject, re.I):  return "bugfixes"
    if re.match(r"^feat[:\(]", subject, re.I): return None  # unclustered feat → skip
    # Include meaningful messages without prefix if ≥ 3 words
    if len(subject.split()) >= 3:
        return "infrastructure"  # catch-all for unmatched
    return None

# ── Deduplizierung innerhalb eines Clusters ────────────────────────────────────

def _word_overlap(a: str, b: str) -> float:
    """Fraction of words in `a` that also appear in `b`."""
    wa = set(re.findall(r"\w+", a.lower()))
    wb = set(re.findall(r"\w+", b.lower()))
    if not wa: return 0.0
    return len(wa & wb) / len(wa)

_REVERT_RE   = re.compile(r"^revert\b", re.I)
_INTERIM_RE  = re.compile(
    r"\b(wip|draft|experiment|attempt|first.try|temp|debug|broken|failing|"
    r"refactor.*again|temporary|placeholder|incomplete)\b", re.I
)

def deduplicate(commits: list[dict]) -> list[dict]:
    """
    Reduce a cluster's commits to ONLY the final state:
    1. Remove reverts (and the commit they reverted, if present)
    2. Remove WIP/experimental commits
    3. When two commits describe the same thing (>55% word overlap),
       keep only the NEWER one (it supersedes the older attempt)

    git log is newest-first, so commits[0] is the most recent.
    We process newest-first so that later commits can remove earlier ones.
    """
    # Build working list newest-first
    work = list(commits)
    result: list[dict] = []

    for commit in work:
        desc   = commit["description"]
        desc_l = desc.lower()

        # Skip reverts entirely — they cancel out a previous change
        if _REVERT_RE.match(desc): continue

        # Skip explicit intermediates / experiments
        if _INTERIM_RE.search(desc): continue

        # Check if a newer commit in result already covers this
        superseded = False
        for kept in list(result):
            overlap = _word_overlap(desc_l, kept["description"].lower())
            if overlap >= 0.55:
                # This commit is older and overlaps with a kept (newer) one → skip
                superseded = True
                break

        if not superseded:
            result.append(commit)

    return result

# ── Priorisierung und Auswahl ─────────────────────────────────────────────────

def synthesize_story(cluster_name: str, commits: list[dict]) -> str:
    """
    Condense N commits into ONE human-readable story for the cluster.
    Picks the most descriptive commit as the headline.
    """
    if not commits: return ""
    # Prefer fix > feat > other as the "final state" representative
    # (the fix is likely the most accurate description of current behavior)
    type_priority = {"fix": 0, "feat": 1, "ux": 2, "other": 3}
    best = min(commits, key=lambda c: (type_priority.get(c.get("type","other"), 3), 0))
    desc = best["description"]

    # For multi-commit clusters, add a count note if >2 distinct commits
    if len(commits) > 2:
        # Count distinct "topics" by word-overlap clustering
        distinct = 1
        for i, c in enumerate(commits[1:], 1):
            if all(_word_overlap(c["description"], prev["description"]) < 0.4
                   for prev in commits[:i]):
                distinct += 1
        if distinct > 1:
            # Don't append count — keep it clean; the story speaks for itself
            pass
    return desc

def select_stories(
    clustered: dict[str, list[dict]],
    devlog_type: str,
    published_clusters: set[str],
    since_date: str,
    until_date: str,
) -> list[dict]:
    """
    Returns selected STORIES (one per cluster), not individual commits.
    A cluster that was communicated before is skipped.

    Returns list of story dicts:
      { storyKey, cluster, clusterLabel, summary, type, sinceDate, untilDate }
    """
    config = DEVLOG_TYPES.get(devlog_type, DEVLOG_TYPES["product"])
    max_total    = config["max_total"]
    only_visible = config["only_visible"]

    selected: list[dict] = []

    # Process clusters in user-priority order
    priority_order = sorted(
        CLUSTERS.items(),
        key=lambda x: (x[1][1], x[0]),
    )

    for cluster_name, (_, priority, is_visible) in priority_order:
        if len(selected) >= max_total: break
        if only_visible and not is_visible: continue

        # Skip clusters already communicated in this context
        if cluster_name in published_clusters: continue

        commits = clustered.get(cluster_name, [])
        if not commits: continue

        # Deduplicate intermediate states
        deduped = deduplicate(commits)
        if not deduped: continue

        # Synthesize ONE story for this cluster
        summary = synthesize_story(cluster_name, deduped)
        if not summary: continue

        # Determine dominant change type
        type_counts: dict[str, int] = {}
        for c in deduped:
            t = c.get("type", "other")
            type_counts[t] = type_counts.get(t, 0) + 1
        dominant_type = max(type_counts, key=lambda t: type_counts[t])

        story_key = f"{cluster_name}-{since_date}"
        selected.append({
            "storyKey":    story_key,
            "cluster":     cluster_name,
            "clusterLabel": CLUSTER_LABELS[cluster_name],
            "summary":     summary,
            "type":        dominant_type,
            "sinceDate":   since_date,
            "untilDate":   until_date,
            "commitCount": len(deduped),
        })

    return selected

# ── Git-Commit-Lesen ──────────────────────────────────────────────────────────

def get_commits(since: str, repo: Path) -> list[dict]:
    cmd = [
        "git", "-C", str(repo), "log",
        f"--since={since}", "--no-merges",
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

def process_commits(commits: list[dict]) -> tuple[dict[str, list[dict]], int]:
    """Assign clusters and build description. Returns (clustered, total_raw)."""
    clustered: dict[str, list[dict]] = defaultdict(list)
    for c in commits:
        cluster = assign_cluster(c["subject"])
        if not cluster: continue
        # Detect change type from conventional prefix
        if re.match(r"^fix[:\(]", c["subject"], re.I): t = "fix"
        elif re.match(r"^feat[:\(]", c["subject"], re.I): t = "feat"
        elif re.match(r"^(ux|refactor)[:\(]", c["subject"], re.I): t = "ux"
        else: t = "other"
        clustered[cluster].append({
            "hash":        c["hash"],
            "description": strip_prefix(c["subject"]),
            "type":        t,
        })
    return dict(clustered), len(commits)

# ── API-Aufrufe ───────────────────────────────────────────────────────────────

def api_get(path: str) -> dict:
    req = urllib_request.Request(
        f"{API_BASE}{path}",
        headers={"X-Operator-Token": OPERATOR_TOKEN},
    )
    with urllib_request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())

def api_post(path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode()
    req  = urllib_request.Request(
        f"{API_BASE}{path}", data=body,
        headers={"Content-Type": "application/json", "X-Operator-Token": OPERATOR_TOKEN},
        method="POST",
    )
    with urllib_request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

def get_published_clusters(context_type: str = "devlog") -> set[str]:
    """Returns set of story_keys already communicated in given context."""
    try:
        data = api_get(f"/api/devlog/published-features?context={context_type}")
        return {f["cluster"] for f in data.get("features", [])}
    except Exception as e:
        print(f"  ⚠  Konnte published-features nicht abrufen: {e}")
        return set()

def get_last_devlog_date() -> str | None:
    try:
        data = api_get("/api/admin/content")
        devlogs = [d for d in data.get("drafts", []) if d["type"] == "devlog-post"]
        if devlogs:
            return sorted(devlogs, key=lambda d: d["dateStr"])[-1]["dateStr"]
    except Exception:
        pass
    return None

def record_stories(draft_filename: str, context_type: str, stories: list[dict]) -> None:
    """Record cluster-stories as communicated (cluster is the unit, not commits)."""
    if not stories: return
    payload = [
        {
            "storyKey":  s["storyKey"],
            "cluster":   s["cluster"],
            "summary":   s["summary"],
            "sinceDate": s.get("sinceDate", "2026-01-01"),
            "untilDate": s.get("untilDate", date.today().isoformat()),
        }
        for s in stories
    ]
    try:
        api_post("/api/devlog/record-stories", {
            "draftFilename": draft_filename,
            "contextType":   context_type,
            "stories": payload,
        })
    except Exception as e:
        print(f"  ⚠  record-stories fehlgeschlagen: {e}")

def call_generate_api(payload: dict) -> dict:
    return api_post("/api/devlog/generate", payload)

# ── Screenshot-Integration ────────────────────────────────────────────────────

def take_screenshots(token: str) -> list[str]:
    capture  = SCRIPT_DIR / "capture.py"
    annotate = SCRIPT_DIR / "annotate.py"
    if not capture.exists():
        print("  ⚠  capture.py nicht gefunden — übersprungen")
        return []
    env = {**os.environ, "SESSION_TOKEN": token}
    print("  Screenshots aufnehmen…")
    subprocess.run([sys.executable, str(capture)], env=env, check=True)
    if annotate.exists():
        print("  Annotiere Screenshots…")
        subprocess.run([sys.executable, str(annotate)], check=True)
    annotated_dir = SCRIPT_DIR / "output" / "annotated"
    return sorted(str(f) for f in annotated_dir.glob("*.png")) if annotated_dir.exists() else []

# ── Hauptprogramm ─────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="VoteBroker Devlog Generator")
    p.add_argument("--type",    choices=["product", "technical", "micro"], default="product",
                   help="Devlog-Typ: product (Standard) | technical | micro")
    p.add_argument("--screenshots",   action="store_true")
    p.add_argument("--date",          default=None)
    p.add_argument("--since",         default=None)
    p.add_argument("--next",          action="append", dest="next_items", metavar="ITEM")
    p.add_argument("--force",         action="store_true")
    p.add_argument("--dry-run",       action="store_true")
    p.add_argument("--session-token", default=None)
    p.add_argument("--mark-published", metavar="FILENAME",
                   help="Markiert Commits eines existierenden Drafts als veröffentlicht (nach manuellem Publish)")
    args = p.parse_args()

    # ── Nur-Markierung-Modus ───────────────────────────────────────────────────
    if args.mark_published:
        sidecar = REPO_ROOT / "tools" / "devlog" / f"{args.mark_published}.stories.json"
        if sidecar.exists():
            stories_data = json.loads(sidecar.read_text())
            ctx = {"product": "product-post", "technical": "devlog", "micro": "devlog"}[devlog_type]
            record_stories(args.mark_published, ctx, stories_data)
            print(f"✓ {len(stories_data)} Cluster-Stories als '{ctx}' markiert für {args.mark_published}")
        else:
            print(f"⚠  Keine Sidecar-Datei gefunden: {sidecar}")
        return

    today_str = args.date or date.today().isoformat()
    devlog_type = args.type
    type_label  = DEVLOG_TYPES[devlog_type]["label"]

    print(f"Devlog-Typ:  {type_label}")
    print(f"Datum:       {today_str}")

    # ── Bereits kommunizierte Cluster holen (Cluster = Einheit, nicht Commits) ──
    context_type = {"product": "product-post", "technical": "devlog", "micro": "devlog"}[devlog_type]
    print(f"Lade bereits kommunizierte Cluster ({context_type})…")
    published_clusters = get_published_clusters(context_type)
    if published_clusters:
        print(f"  Bereits kommuniziert: {', '.join(sorted(published_clusters))}")
    else:
        print("  Keine bisherigen Einträge gefunden")

    # ── Seit-Datum bestimmen ───────────────────────────────────────────────────
    since_date = args.since
    if not since_date:
        since_date = get_last_devlog_date()
        if since_date:
            print(f"Letzter Devlog: {since_date}")
        else:
            since_date = "2026-05-01"
            print(f"Kein vorheriger Devlog — git log seit {since_date}")

    # ── Git-Commits lesen und clustern ─────────────────────────────────────────
    print(f"Lese Commits seit {since_date}…")
    raw_commits = get_commits(since_date, REPO_ROOT)
    clustered, total_raw = process_commits(raw_commits)

    total_clustered = sum(len(v) for v in clustered.values())
    print(f"  {total_raw} Commits → {total_clustered} geclustert")

    # Cluster-Übersicht ausgeben
    for cluster_name, commits in sorted(clustered.items(), key=lambda x: CLUSTERS[x[0]][1]):
        if cluster_name not in published_clusters and commits:
            label = CLUSTER_LABELS[cluster_name]
            print(f"  [{label:25}] {len(commits)} Commits (neu)")

    # ── Stories auswählen (1 Story pro Cluster) ────────────────────────────────
    until_date = today_str
    stories = select_stories(clustered, devlog_type, published_clusters, since_date, until_date)

    print(f"\nAuswahl für '{type_label}': {len(stories)} Stories")
    for s in stories:
        n = s.get("commitCount", 1)
        print(f"  [{s['clusterLabel']:25}] {s['summary'][:60]}  ({n} Commit{'s' if n>1 else ''})")

    if not stories:
        print("\nKeine neuen Cluster — Draft wird nicht erzeugt.")
        return

    # ── Screenshots ───────────────────────────────────────────────────────────
    screenshots: list[str] = []
    if args.screenshots:
        token = args.session_token or os.environ.get("SESSION_TOKEN", "")
        if not token:
            print("  ⚠  Kein SESSION_TOKEN für Screenshots")
        else:
            screenshots = take_screenshots(token)
            print(f"  {len(screenshots)} Screenshots")

    # ── API-Payload (DevlogChange-Format) ─────────────────────────────────────
    api_changes = [
        {"type": s["type"], "description": s["summary"]}
        for s in stories
    ]
    payload: dict = {
        "date":      today_str,
        "changes":   api_changes,
        "sinceDate": since_date,
        "force":     args.force,
    }
    if args.next_items: payload["nextItems"]   = args.next_items
    if screenshots:     payload["screenshots"] = screenshots

    if args.dry_run:
        print("\n--- Dry-run (API nicht aufgerufen) ---")
        for s in stories:
            print(f"  [{s['clusterLabel']}] {s['summary']}")
        print(json.dumps(payload, indent=2, ensure_ascii=False)[:2000])
        return

    # ── Draft erzeugen ─────────────────────────────────────────────────────────
    print("\nErzeuge Draft…")
    result = call_generate_api(payload)
    print(f"  Ergebnis: {result['status']} — {result['filename']}")

    # ── Stories in Wissensdatenbank eintragen ──────────────────────────────────
    # Einheit: Cluster-Story, nicht einzelne Commits.
    # Beim nächsten Generate werden diese Cluster übersprungen.
    if result["status"] in ("created", "updated"):
        record_stories(result["filename"], context_type, stories)
        sidecar = REPO_ROOT / "tools" / "devlog" / f"{result['filename']}.stories.json"
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_text(json.dumps(stories, ensure_ascii=False, indent=2))
        print(f"  {len(stories)} Cluster-Stories als '{context_type}' in Wissensdatenbank eingetragen")
        print(f"  Sidecar: {sidecar.name}")

    print("\nFertig.")

if __name__ == "__main__":
    main()
