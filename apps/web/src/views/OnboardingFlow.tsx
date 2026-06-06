import { Users, Dna, Target, LayoutDashboard, type LucideIcon } from "lucide-react";
import { createTranslator, type TranslationKey } from "../i18n";

type WorkflowTab = "community" | "dna" | "dashboard";

const STEPS: Array<{
  icon: LucideIcon;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  tab: WorkflowTab;
  color: string;
}> = [
  { icon: Users,           titleKey: "stepCommunity", descKey: "stepCommunityDesc", tab: "community", color: "#7c3aed" },
  { icon: Dna,             titleKey: "stepDna",       descKey: "stepDnaDesc",       tab: "dna",       color: "#2563eb" },
  { icon: Target,          titleKey: "stepStrategy",  descKey: "stepStrategyDesc",  tab: "dna",       color: "#16a34a" },
  { icon: LayoutDashboard, titleKey: "stepDashboard", descKey: "stepDashboardDesc", tab: "dashboard", color: "#d97706" },
];

export function OnboardingFlow({ onTabChange, t }: {
  onTabChange: (tab: WorkflowTab) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.6rem" }}>
      {STEPS.map((step, i) => {
        const Icon = step.icon;
        return (
          <button
            key={step.titleKey}
            type="button"
            onClick={() => onTabChange(step.tab)}
            style={{
              display: "flex", alignItems: "center", gap: "0.85rem",
              padding: "0.75rem 1rem",
              background: `${step.color}08`,
              border: `1px solid ${step.color}28`,
              borderRadius: "10px",
              cursor: "pointer",
              textAlign: "left" as const,
              width: "100%",
              transition: "background 0.15s, border-color 0.15s",
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = `${step.color}14`;
              el.style.borderColor = `${step.color}50`;
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = `${step.color}08`;
              el.style.borderColor = `${step.color}28`;
            }}
          >
            <div style={{
              width: "32px", height: "32px", borderRadius: "8px", flexShrink: 0,
              background: `${step.color}15`, border: `1px solid ${step.color}30`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ color: step.color, fontSize: "0.65rem", fontWeight: 900, opacity: 0.7 }}>{i + 1}</span>
            </div>
            <Icon size={18} color={step.color} strokeWidth={1.75} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: step.color, fontWeight: 700, fontSize: "0.82rem", lineHeight: 1.2 }}>{t(step.titleKey)}</div>
              <div style={{ color: "#4b6070", fontSize: "0.7rem", marginTop: "2px", lineHeight: 1.3 }}>{t(step.descKey)}</div>
            </div>
            <span style={{ color: step.color, fontSize: "0.75rem", opacity: 0.6, flexShrink: 0 }}>›</span>
          </button>
        );
      })}
    </div>
  );
}
