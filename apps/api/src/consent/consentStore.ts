import type { ConsentRecord, ConsentState, ConsentType } from "@votebroker/domain";
import { randomUUID } from "node:crypto";

const consentHistory = new Map<string, ConsentRecord[]>();

export const consentCatalog: Record<ConsentType, Omit<ConsentRecord, "id" | "username" | "status" | "createdAt" | "revokedAt">> = {
  login: {
    type: "login",
    title: "Login-Consent",
    description: "VoteBroker darf deinen SteemConnect Login nutzen, um dich eindeutig deinem Account zuzuordnen.",
    scope: ["Accountname lesen", "lokale VoteBroker-Session erstellen"]
  },
  target_vote: {
    type: "target_vote",
    title: "Vote-Consent",
    description: "VoteBroker darf von dir bestaetigte Zielvotes mit dem berechneten Vote-Gewicht ausfuehren.",
    scope: ["Zielpost voten", "Vote-Gewicht aus USD-Zielwert berechnen", "Vote-Ausfuehrung protokollieren"]
  },
  fee_post_vote: {
    type: "fee_post_vote",
    title: "Fee-Post-Consent",
    description: "VoteBroker darf die transparente Servicegebuehr durch einen Vote auf den ausgewiesenen Gebuehrenpost begleichen.",
    scope: ["Gebuehrenpost anzeigen", "Fee-Vote berechnen", "Fee-Vote nur fuer offene Rechnung ausfuehren"]
  },
  auto_vote: {
    type: "auto_vote",
    title: "Optionaler Auto-Vote-Consent",
    description: "VoteBroker darf passende Votes automatisch ausfuehren, solange Limits, Status und Widerruf dies erlauben.",
    scope: ["Auto-Vote-Regeln anwenden", "Limits beachten", "bei Widerruf sofort stoppen"]
  }
};

export function getConsentState(username: string): ConsentState {
  const history = consentHistory.get(username) ?? [];
  const active = history.filter((record) => record.status === "granted" && !record.revokedAt);
  return {
    username,
    active,
    history: [...history].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  };
}

export function grantConsent(username: string, type: ConsentType): ConsentRecord {
  revokeConsent(username, type);
  const template = consentCatalog[type];
  const record: ConsentRecord = {
    ...template,
    id: randomUUID(),
    username,
    status: "granted",
    createdAt: new Date().toISOString()
  };
  const history = consentHistory.get(username) ?? [];
  history.push(record);
  consentHistory.set(username, history);
  return record;
}

export function revokeConsent(username: string, type: ConsentType): ConsentRecord | undefined {
  const history = consentHistory.get(username) ?? [];
  const active = [...history].reverse().find((record) => record.type === type && record.status === "granted" && !record.revokedAt);
  if (!active) {
    return undefined;
  }

  active.status = "revoked";
  active.revokedAt = new Date().toISOString();
  return active;
}

export function hasConsent(username: string, type: ConsentType): boolean {
  return getConsentState(username).active.some((record) => record.type === type);
}
