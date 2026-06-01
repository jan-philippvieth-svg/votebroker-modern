// Shared design tokens — matches Community tab (styles.css) + UserDashboard
// Page bg: #f4f7f8  Cards: #ffffff + shadow  Text: #17202a  Accent: #1c7c73

export const D = {
  // Text hierarchy
  text:    "#17202a",
  muted:   "#607078",
  faint:   "#8fa4b0",
  dim:     "#4b6070",

  // Surfaces
  pageBg:  "#f4f7f8",
  card:    "#ffffff",
  inner:   "#f0f5f7",   // progress bar tracks, secondary areas
  inner2:  "#e4ecf0",   // slightly stronger inner

  // Borders
  border:  "#dde8ed",
  border2: "#c5d3da",

  // Semantic accents — vibrant, high contrast on white
  ok:      "#16a34a",
  warn:    "#d97706",
  err:     "#dc2626",
  info:    "#2563eb",
  purple:  "#7c3aed",
  teal:    "#0d9488",
  fire:    "#ea580c",
  gold:    "#d97706",

  // Card shadow (matches Community tab panels)
  shadow:  "0 2px 8px rgba(17,37,45,0.06), 0 1px 3px rgba(17,37,45,0.04)",
  shadowMd:"0 4px 16px rgba(17,37,45,0.08), 0 1px 4px rgba(17,37,45,0.05)",
} as const;

// Reusable style objects for inline use
export const DS = {
  card: {
    background: D.card,
    border: `1px solid ${D.border}`,
    borderRadius: "14px",
    padding: "1.25rem 1.5rem",
    boxShadow: D.shadow,
  } as React.CSSProperties,

  cardLg: {
    background: D.card,
    border: `1px solid ${D.border}`,
    borderRadius: "16px",
    padding: "1.5rem 1.75rem",
    boxShadow: D.shadow,
  } as React.CSSProperties,

  inner: {
    background: D.inner,
    border: `1px solid ${D.border}`,
    borderRadius: "10px",
    padding: "1rem 1.25rem",
  } as React.CSSProperties,

  label: {
    color: D.faint,
    fontSize: "0.7rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "1px",
    margin: "0 0 0.75rem",
  } as React.CSSProperties,

  sectionLabel: {
    color: D.muted,
    fontSize: "0.75rem",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    margin: "0 0 0.5rem",
    fontWeight: 600,
  } as React.CSSProperties,

  chipBtn: {
    background: D.inner,
    border: `1px solid ${D.border2}`,
    borderRadius: "6px",
    color: D.muted,
    cursor: "pointer" as const,
    fontSize: "0.78rem",
    padding: "0.3rem 0.65rem",
  } as React.CSSProperties,

  primaryBtn: {
    background: `${D.info}15`,
    border: `1px solid ${D.info}40`,
    borderRadius: "6px",
    color: D.info,
    cursor: "pointer" as const,
    fontSize: "0.78rem",
    padding: "0.3rem 0.65rem",
    fontWeight: 600,
  } as React.CSSProperties,

  successBtn: {
    background: `${D.ok}15`,
    border: `1px solid ${D.ok}40`,
    borderRadius: "6px",
    color: D.ok,
    cursor: "pointer" as const,
    fontSize: "0.78rem",
    padding: "0.3rem 0.65rem",
    fontWeight: 600,
  } as React.CSSProperties,

  track: {
    height: "6px",
    background: D.inner2,
    borderRadius: "3px",
    overflow: "hidden" as const,
  } as React.CSSProperties,
} as const;
