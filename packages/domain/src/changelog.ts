export type ChangelogCategory =
  | "feature"      // New capability shipped
  | "improvement"  // Enhancement to existing feature
  | "bugfix"       // Problem resolved
  | "infra"        // Infrastructure / deployment change
  | "milestone"    // Significant project milestone
  | "roadmap"      // Announced upcoming feature
  | "status";      // System-status change

export type FeatureStatus = "live" | "beta" | "preview" | "deprecated" | "offline";

export type KnownIssueState = "planned" | "in_progress" | "monitoring" | "resolved";

export interface ChangelogEntry {
  date: string;                    // "YYYY-MM-DD" UTC
  category: ChangelogCategory;
  title: string;                   // Short: "Vote-DNA Analysis"
  description: string;             // Full: "Analyzes last 500 votes..."
  status?: FeatureStatus;          // Current state of the feature
  component?: string;              // "auth" | "dna" | "voting" | "billing" | "infra" | "ui"
  promotedToDescription?: boolean; // true → include in static product section once stable
}

export interface KnownIssue {
  id: string;                // Unique slug: "invoice-persistence"
  title: string;             // Short label: "Invoice Persistence (RAM only)"
  description: string;       // One sentence: what is affected and what is planned
  state: KnownIssueState;    // planned | in_progress | monitoring | resolved
  component?: string;        // "auth" | "dna" | "voting" | "billing" | "infra" | "ui"
  addedDate: string;         // "YYYY-MM-DD" when first identified
  updatedDate?: string;      // "YYYY-MM-DD" when state last changed
}

export interface SystemStatus {
  oauth:     FeatureStatus;
  authority: FeatureStatus;
  voteDna:   FeatureStatus;
  voting:    FeatureStatus;
  billing:   FeatureStatus;
  feePost:   FeatureStatus;
}

const STATUS_EMOJI: Record<FeatureStatus, string> = {
  live:       "🟢",
  beta:       "🟡",
  preview:    "⚪",
  deprecated: "🔴",
  offline:    "⚫"
};

const CATEGORY_ICON: Record<ChangelogCategory, string> = {
  feature:     "🚀",
  improvement: "✨",
  bugfix:      "✅",
  infra:       "🔧",
  milestone:   "🏁",
  roadmap:     "📍",
  status:      "📋"
};

const CATEGORY_LABEL: Record<ChangelogCategory, string> = {
  feature:     "New Features",
  improvement: "Improvements",
  bugfix:      "Bug Fixes",
  infra:       "Infrastructure",
  milestone:   "Milestones",
  roadmap:     "On the Roadmap",
  status:      "Status Changes"
};

const STATUS_LABEL: Record<string, string> = {
  oauth:     "OAuth Login",
  authority: "Posting Authority",
  voteDna:   "Vote-DNA Analysis",
  voting:    "Vote Execution",
  billing:   "Fee Settlement",
  feePost:   "Daily Fee Posts"
};

/** Groups entries by category and formats as markdown. Returns empty string if no entries. */
export function formatChangelogSection(
  entries: ChangelogEntry[],
  date: string
): string {
  const todayEntries = entries.filter(e => e.date === date);
  if (todayEntries.length === 0) return "";

  const groups = new Map<ChangelogCategory, ChangelogEntry[]>();
  const order: ChangelogCategory[] = [
    "feature", "improvement", "bugfix", "milestone", "infra", "roadmap", "status"
  ];

  for (const entry of todayEntries) {
    if (!groups.has(entry.category)) groups.set(entry.category, []);
    groups.get(entry.category)!.push(entry);
  }

  const lines: string[] = ["## 📰 What's New\n"];

  for (const cat of order) {
    const group = groups.get(cat);
    if (!group) continue;
    lines.push(`### ${CATEGORY_ICON[cat]} ${CATEGORY_LABEL[cat]}`);
    for (const e of group) {
      const statusTag = e.status ? ` *(${e.status})*` : "";
      lines.push(`- **${e.title}**${statusTag} — ${e.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Formats the system status table. */
export function formatSystemStatus(status: SystemStatus): string {
  const rows = Object.entries(status)
    .map(([key, val]) => {
      const label = STATUS_LABEL[key] ?? key;
      const emoji = STATUS_EMOJI[val as FeatureStatus] ?? "⚪";
      const text  = val.charAt(0).toUpperCase() + val.slice(1);
      return `| ${label} | ${emoji} ${text} |`;
    })
    .join("\n");

  return `### 📋 System Status\n\n| Feature | Status |\n|---------|--------|\n${rows}\n`;
}

/** Collects all entries marked promotedToDescription=true, for inclusion in the static product section. */
export function collectPromotedFeatures(entries: ChangelogEntry[]): ChangelogEntry[] {
  return entries.filter(e => e.promotedToDescription && e.status === "live");
}

const ISSUE_STATE_EMOJI: Record<KnownIssueState, string> = {
  planned:     "🔵",
  in_progress: "🟡",
  monitoring:  "🟠",
  resolved:    "✅"
};

const ISSUE_STATE_LABEL: Record<KnownIssueState, string> = {
  planned:     "Planned",
  in_progress: "In Progress",
  monitoring:  "Monitoring",
  resolved:    "Resolved"
};

/**
 * Formats the persistent Known Issues section.
 * Resolved issues are excluded — they have been fixed and do not belong in the post.
 * Returns empty string if all issues are resolved.
 */
export function formatKnownIssues(issues: KnownIssue[]): string {
  const open = issues.filter(i => i.state !== "resolved");
  if (open.length === 0) return "";

  const lines = open.map(i => {
    const badge = `${ISSUE_STATE_EMOJI[i.state]} **${ISSUE_STATE_LABEL[i.state]}**`;
    const tag   = i.component ? ` \`${i.component}\`` : "";
    return `- ${badge} — **${i.title}**${tag}: ${i.description}`;
  });

  return `---\n\n## ⚠️ Known Limitations\n\n${lines.join("\n")}\n`;
}
