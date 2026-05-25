import { randomBytes } from "node:crypto";

export interface AuthUser {
  username: string;
  provider: "steemconnect";
  accessToken?: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
  expiry: string;
}

const sessions = new Map<string, AuthSession>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 3;

export function createSession(user: AuthUser): AuthSession {
  const token = randomBytes(36).toString("base64url");
  const session: AuthSession = {
    token,
    user,
    expiry: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
  sessions.set(token, session);
  return session;
}

export function getSession(token: string | undefined): AuthSession | undefined {
  if (!token) {
    return undefined;
  }

  const session = sessions.get(token);
  if (!session) {
    return undefined;
  }

  if (Date.parse(session.expiry) <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }

  return session;
}

export function deleteSession(token: string | undefined): void {
  if (token) {
    sessions.delete(token);
  }
}
