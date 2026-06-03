import type { ConsentRecord, ConsentState, ConsentType } from "@votebroker/domain";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";

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
    title: "Automatisches Voting",
    description: "VoteBroker darf in deinem Namen Votes auf Steem senden — nach deiner expliziten Freigabe und nur gemaess deiner Strategie.",
    scope: ["Votes gemaess Strategie senden", "Limits und VP-Budget beachten", "sofort stoppen bei Widerruf"]
  },
  ai_strategy: {
    type: "ai_strategy",
    title: "AI Strategie Optimierung",
    description: "VoteBroker analysiert deine Voting-Historie um personalisierte Strategie-Empfehlungen zu erstellen.",
    scope: ["Voting-Historie lokal analysieren", "Autor-Rankings berechnen", "Strategie-Vorschlaege generieren", "Keine Weitergabe an Dritte"]
  },
  community_intelligence: {
    type: "community_intelligence",
    title: "Community Intelligence",
    description: "Anonymisiert an Community-Empfehlungen teilnehmen — deine Autoren-Praeferenzen fliessen in den Author Radar ein.",
    scope: ["Autoren-Praeferenzen anonymisiert aggregieren", "Author-Radar-Empfehlungen verbessern", "Kein Benutzername oder Strategie veroeffentlicht", "Opt-out jederzeit moeglich"]
  }
};

type ConsentRow = {
  id: string;
  username: string;
  type: ConsentType;
  status: "granted" | "revoked";
  created_at: string;
  revoked_at: string | null;
};

function rowToRecord(row: ConsentRow): ConsentRecord {
  const template = consentCatalog[row.type];
  return {
    id: row.id,
    username: row.username,
    type: row.type,
    status: row.status,
    title: template.title,
    description: template.description,
    scope: template.scope,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? undefined
  };
}

export function getConsentState(username: string): ConsentState {
  const rows = getDb().prepare(`
    SELECT * FROM consents WHERE username = ? ORDER BY created_at DESC
  `).all(username) as ConsentRow[];

  const history = rows.map(rowToRecord);
  const active  = history.filter(r => r.status === "granted" && !r.revokedAt);

  return { username, active, history };
}

export function grantConsent(username: string, type: ConsentType): ConsentRecord {
  // Revoke any currently active consent of this type first
  revokeConsent(username, type);

  const id        = randomUUID();
  const createdAt = new Date().toISOString();

  getDb().prepare(`
    INSERT INTO consents (id, username, type, status, created_at)
    VALUES (?, ?, ?, 'granted', ?)
  `).run(id, username, type, createdAt);

  const template = consentCatalog[type];
  return {
    id, username, type, status: "granted",
    title: template.title,
    description: template.description,
    scope: template.scope,
    createdAt
  };
}

export function revokeConsent(username: string, type: ConsentType): ConsentRecord | undefined {
  const db = getDb();

  const active = db.prepare(`
    SELECT * FROM consents
    WHERE username = ? AND type = ? AND status = 'granted' AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(username, type) as ConsentRow | undefined;

  if (!active) return undefined;

  const revokedAt = new Date().toISOString();
  db.prepare(`
    UPDATE consents SET status = 'revoked', revoked_at = ? WHERE id = ?
  `).run(revokedAt, active.id);

  return rowToRecord({ ...active, status: "revoked", revoked_at: revokedAt });
}

export function hasConsent(username: string, type: ConsentType): boolean {
  const row = getDb().prepare(`
    SELECT id FROM consents
    WHERE username = ? AND type = ? AND status = 'granted' AND revoked_at IS NULL
    LIMIT 1
  `).get(username, type);
  return Boolean(row);
}
