import { randomBytes } from "node:crypto";

interface PendingAuthState {
  state: string;
  createdAt: number;
}

const AUTH_STATE_TTL_MS = 1000 * 60 * 10;
const states = new Map<string, PendingAuthState>();

function pruneExpiredStates(): void {
  const now = Date.now();
  for (const [state, pending] of states.entries()) {
    if (now - pending.createdAt > AUTH_STATE_TTL_MS) {
      states.delete(state);
    }
  }
}

export function createAuthState(): string {
  pruneExpiredStates();
  const state = randomBytes(32).toString("base64url");
  states.set(state, {
    state,
    createdAt: Date.now()
  });
  return state;
}

export function consumeAuthState(state: string | undefined): boolean {
  if (!state) {
    return false;
  }

  pruneExpiredStates();
  const pending = states.get(state);
  if (!pending) {
    return false;
  }

  states.delete(state);
  return Date.now() - pending.createdAt <= AUTH_STATE_TTL_MS;
}
