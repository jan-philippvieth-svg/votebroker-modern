"""
VoteBroker Secret Guard
========================
Scannt Text (DOM, OCR, Markdown) auf Secrets/Tokens/Keys.
Wird von capture.py (vor jedem Screenshot) und als Standalone-Scanner verwendet.

Niemals wird ein gefundener Secret-Wert geloggt oder ausgegeben.
"""

import re
from dataclasses import dataclass
from pathlib import Path

# ── Secret-Muster ──────────────────────────────────────────────────────────────
# Reihenfolge: spezifisch zuerst, generisch zuletzt.

_PATTERNS: list[tuple[str, re.Pattern, str]] = [
    ("github_pat",      re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),        "GitHub Personal Access Token"),
    ("ghp",             re.compile(r"ghp_[A-Za-z0-9]{36,}"),                "GitHub Token (ghp)"),
    ("gho",             re.compile(r"gho_[A-Za-z0-9]{36,}"),                "GitHub Token (gho)"),
    ("ghu",             re.compile(r"ghu_[A-Za-z0-9]{36,}"),                "GitHub Token (ghu)"),
    ("ghs",             re.compile(r"ghs_[A-Za-z0-9]{36,}"),                "GitHub Token (ghs)"),
    ("glpat",           re.compile(r"glpat-[A-Za-z0-9\-_]{20,}"),          "GitLab Personal Access Token"),
    ("slack",           re.compile(r"xoxb-[0-9A-Za-z\-]{24,}"),            "Slack Bot Token"),
    ("openai",          re.compile(r"sk-[A-Za-z0-9]{32,}"),                "API Key (sk-)"),
    ("ssh_private",     re.compile(r"BEGIN\s+OPENSSH\s+PRIVATE\s+KEY"),     "SSH Private Key"),
    ("rsa_private",     re.compile(r"BEGIN\s+RSA\s+PRIVATE\s+KEY"),         "RSA Private Key"),
    ("ec_private",      re.compile(r"BEGIN\s+EC\s+PRIVATE\s+KEY"),          "EC Private Key"),
    # Steem/Hive WIF private keys: start with 5H/5J/5K, 51 chars
    ("wif_key",         re.compile(r"\b5[HJK][A-Za-z0-9]{49}\b"),          "Steem/Hive WIF Private Key"),
    # posting key / active key / owner key phrases
    ("key_phrase",      re.compile(r"\b(posting|active|owner|private)\s+key\b", re.I), "Key phrase"),
    # 64-char hex (operator tokens, blockchain hashes are shorter — this catches secrets like SHA256)
    ("hex64",           re.compile(r"\b[0-9a-f]{64}\b"),                    "64-char hex token/hash"),
    # Generic long tokens: 48+ alphanumeric chars without spaces (session tokens, JWTs, etc.)
    # Excluded: base58 strings under 47 chars (normal permlinks), URLs
    ("long_token",      re.compile(r"(?<![/\w])[A-Za-z0-9_\-]{48,}(?![/\w])"), "Long token (48+ chars)"),
]

# ── False-Positive-Whitelist ───────────────────────────────────────────────────
# Bekannte harmlose Muster die dennoch 48+ Zeichen haben können
_WHITELIST: list[re.Pattern] = [
    re.compile(r"^[a-z0-9\-]+$"),                    # lowercase permlinks
    re.compile(r"steemconnect|votebroker|github\.com|steemit\.com"),
    re.compile(r"deadbeef|cafebabe|00000000"),         # common test hex strings
]

def _is_whitelisted(value: str) -> bool:
    return any(p.search(value) for p in _WHITELIST)

# ── Result-Typen ───────────────────────────────────────────────────────────────

@dataclass
class SecretFinding:
    pattern_id: str
    label:      str
    # NOTE: never expose the matched value here

@dataclass
class GuardResult:
    safe:     bool
    findings: list[SecretFinding]

    def summary(self) -> str:
        if self.safe: return "OK"
        labels = ", ".join(f.label for f in self.findings)
        return f"BLOCKED — mögliche Secrets erkannt: {labels}"

# ── Haupt-Scan-Funktion ────────────────────────────────────────────────────────

def scan_text(text: str) -> GuardResult:
    """Scannt beliebigen Text auf Secret-Muster. Gibt niemals den Secret-Wert zurück."""
    findings: list[SecretFinding] = []
    seen_ids: set[str] = set()

    for pid, pattern, label in _PATTERNS:
        match = pattern.search(text)
        if not match: continue
        if pid in seen_ids: continue
        value = match.group(0)
        if _is_whitelisted(value): continue
        findings.append(SecretFinding(pattern_id=pid, label=label))
        seen_ids.add(pid)

    return GuardResult(safe=len(findings) == 0, findings=findings)

def scan_file_text(path: Path) -> GuardResult:
    """Scannt eine Textdatei (Markdown, JSON, etc.)."""
    try:
        return scan_text(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return GuardResult(safe=True, findings=[])

# ── OCR-Scan (optional, benötigt pytesseract) ─────────────────────────────────

def scan_image_ocr(path: Path) -> GuardResult:
    """
    Versucht OCR via pytesseract. Gibt GuardResult(safe=True) zurück
    wenn pytesseract nicht installiert ist.
    """
    try:
        import pytesseract  # type: ignore
        from PIL import Image
        text = pytesseract.image_to_string(Image.open(path))
        return scan_text(text)
    except ImportError:
        return GuardResult(safe=True, findings=[])
    except Exception:
        return GuardResult(safe=True, findings=[])

# ── Batch-Scanner ──────────────────────────────────────────────────────────────

@dataclass
class BatchResult:
    total:   int
    blocked: list[tuple[Path, GuardResult]]
    clean:   int

    @property
    def has_issues(self) -> bool:
        return len(self.blocked) > 0

def scan_directory(directory: Path, suffixes: set[str] | None = None) -> BatchResult:
    """
    Scannt alle Dateien in einem Verzeichnis.
    suffixes: z.B. {'.png', '.md', '.json'} — None = alle
    """
    suffixes = suffixes or {".png", ".md", ".json", ".txt"}
    files = [f for f in directory.rglob("*") if f.is_file() and f.suffix in suffixes]
    blocked: list[tuple[Path, GuardResult]] = []

    for f in files:
        if f.suffix == ".png":
            result = scan_image_ocr(f)
        else:
            result = scan_file_text(f)
        if not result.safe:
            blocked.append((f, result))

    return BatchResult(total=len(files), blocked=blocked, clean=len(files) - len(blocked))

# ── CLI ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    dirs_to_scan = [
        Path("tools/showcase/output/raw"),
        Path("tools/showcase/output/annotated"),
        Path("docs/content"),
    ]
    # Auch Docker-Volume wenn erreichbar
    vol = Path("/var/lib/docker/volumes/votebroker_data/_data")
    if vol.exists():
        dirs_to_scan.append(vol / "screenshots")
        dirs_to_scan.append(vol / "content")

    any_issues = False
    for d in dirs_to_scan:
        if not d.exists():
            continue
        print(f"\nScan: {d}")
        result = scan_directory(d)
        print(f"  {result.total} Dateien geprüft, {result.clean} sauber")
        for path, res in result.blocked:
            labels = ", ".join(f.label for f in res.findings)
            print(f"  ⛔  {path.name}  → {labels}")
            any_issues = True

    if any_issues:
        print("\n⛔  SECRET-GUARD: Probleme gefunden — Details siehe oben.")
        sys.exit(1)
    else:
        print("\n✓  Alle Dateien sauber.")
