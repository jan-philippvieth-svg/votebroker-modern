export type ConsentType =
  | "login"
  | "target_vote"
  | "fee_post_vote"
  | "auto_vote"
  | "ai_strategy"
  | "community_intelligence";

export type ConsentStatus = "granted" | "revoked";

export interface ConsentRecord {
  id: string;
  username: string;
  type: ConsentType;
  status: ConsentStatus;
  title: string;
  description: string;
  scope: string[];
  createdAt: string;
  revokedAt?: string;
}

export interface ConsentState {
  username: string;
  active: ConsentRecord[];
  history: ConsentRecord[];
}

export const requiredConsentTypes: ConsentType[] = [
  "login",
  "target_vote",
  "fee_post_vote"
];

export function hasActiveConsent(state: ConsentState, type: ConsentType): boolean {
  return state.active.some((record) => record.type === type && record.status === "granted");
}

export function hasRequiredConsents(state: ConsentState): boolean {
  return requiredConsentTypes.every((type) => hasActiveConsent(state, type));
}
